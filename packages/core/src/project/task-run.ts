import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { GraphOp, GraphReply } from "@turtle/protocol";
import type { TurtleConfig } from "../config.js";
import { TurtleDb } from "../db/db.js";
import type { SandboxMode, TurtleNode } from "../db/types.js";
import { GitStore } from "../git/store.js";
import { checkpointOf, OpsError, requestStop } from "../ops.js";
import {
  type GraphCallContext,
  queueInstruction,
  type RunEvent,
  type RunOptions,
  type RunOutcome,
  RunSession,
  type TaskBinding,
} from "../run/session.js";
import type { Summarizer } from "../run/summarizer.js";
import type { RunnerLauncher } from "../run/transport.js";
import { assembleTaskContext, graphText } from "./context.js";
import type { Project } from "./project.js";
import { openRunSources } from "./sources.js";
import type { Actor, Concept, LinkTarget, TaskStatus } from "./types.js";
import { shortConceptIds } from "./view.js";

const MAX_TASKS_PER_RUN = 8;
const MAX_DEPTH_BELOW = 3;
const MAX_FINDINGS_PER_RUN = 60;

/**
 * Connects one run to its task (docs/phase2-spec.md §8): answers the agent's graph
 * tools and keeps the task's status, branches and evidence current.
 */
export class TaskRunBinding implements TaskBinding {
  private actor: Extract<Actor, { type: "agent" }>;
  private created = 0;
  private findings = 0;
  private readonly seen = new Map<string, number>();
  private briefUpdated = false;

  constructor(
    private readonly project: Project,
    readonly taskId: string,
    private readonly primarySource: string,
  ) {
    this.actor = { type: "agent", id: "pending", onBehalfOf: project.identity.memberId };
  }

  private get task(): Concept {
    const t = this.project.getConcept(this.taskId);
    if (!t) throw new OpsError(`task ${this.taskId} no longer exists`);
    return t;
  }

  async onStart(info: {
    agentId: string;
    branchId: string;
    companions: { source: string; branchId: string }[];
  }) {
    this.actor = { type: "agent", id: info.agentId, onBehalfOf: this.project.identity.memberId };
    const known = this.task.branches ?? [];
    const next = [
      { source: this.primarySource, branch: info.branchId },
      ...info.companions.map((c) => ({ source: c.source, branch: c.branchId })),
    ];
    const merged = [...known.filter((k) => !next.some((n) => n.source === k.source)), ...next];
    await this.project.updateConcept(
      this.taskId,
      { status: "running", branches: merged },
      { actor: this.actor },
    );
  }

  checkpointNote(): string | undefined {
    if (this.briefUpdated) return undefined;
    const brief = this.task.brief;
    return brief
      ? `Your task's brief was not updated in this run. It still says: "${brief.split("\n")[0]?.slice(0, 160)}". Update it with mcp__turtle__brief.`
      : "Your task has no brief yet. Write one with mcp__turtle__brief: status first, then conclusions with evidence, then open questions.";
  }

  async onCheckpoint(node: TurtleNode) {
    await this.project.link(this.taskId, "evidence", { type: "node", id: node.id }, this.actor);
  }

  async onEnd(outcome: RunOutcome) {
    const task = this.task;
    if (task.status === "abandoned" || task.status === "dropped") return;
    const openQuestion = this.project.db
      .listConcepts({ parentId: task.id, kind: "question" })
      .some((q) => !q.answer);
    const map: Record<RunOutcome["reason"], TaskStatus> = {
      done: "done",
      need_decision: "need_decision",
      blocked: "blocked",
      killed: "paused",
      failed: "failed",
    };
    const status: TaskStatus =
      openQuestion && outcome.reason !== "failed" ? "need_decision" : map[outcome.reason];
    const fields: Partial<Concept> = { status };
    if (!task.brief) {
      const last = this.project.db
        .listLinks({ from: task.id, rel: "evidence" })
        .filter((l) => l.to.type === "node")
        .at(-1);
      fields.brief = `${status}. ${last ? `Last checkpoint ${last.to.id.slice(0, 6)}.` : "No checkpoint."}`;
    }
    await this.project.updateConcept(task.id, fields, { actor: this.actor });
  }

  async handle(
    op: GraphOp,
    args: Record<string, unknown>,
    ctx: GraphCallContext,
  ): Promise<GraphReply> {
    const p = this.project;
    const short = shortConceptIds(p);
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
    switch (op) {
      case "read": {
        const text = graphText(p, this.taskId, args.scope === "goal" ? "goal" : "task");
        for (const c of p.db.listConcepts()) this.seen.set(c.id, c.version);
        return { message: text };
      }
      case "task": {
        if (args.op === "update") return this.updateTask(args);
        if (this.created >= MAX_TASKS_PER_RUN)
          throw new OpsError(
            `at most ${MAX_TASKS_PER_RUN} tasks per run; finish or ask the human first`,
          );
        const title = str("title");
        if (!title) throw new OpsError("a title is required");
        const planner = this.task.role === "planner" && this.task.parentId;
        const parentId = args.parentId
          ? p.resolveConcept(String(args.parentId)).id
          : planner
            ? (this.task.parentId as string)
            : this.taskId;
        // A planner fills in its goal: its tasks go next to it.
        if (
          !(planner && parentId === this.task.parentId) &&
          this.depthBelowTask(parentId) + 1 > MAX_DEPTH_BELOW
        )
          throw new OpsError(`subtasks may be at most ${MAX_DEPTH_BELOW} levels below your task`);
        const dependsOn = Array.isArray(args.dependsOn)
          ? (args.dependsOn as unknown[]).map((d) => p.resolveConcept(String(d)).id)
          : [];
        const sf = str("startFrom");
        const startFrom = sf
          ? { taskId: this.taskId, checkpointId: sf === "here" ? ctx.lastCheckpointId : sf }
          : null;
        const t = await p.createConcept(
          {
            kind: "task",
            parentId,
            title,
            ...(str("body") ? { body: str("body") } : {}),
            dependsOn,
            assignee: { type: "agent" },
            ...(startFrom ? { startFrom } : {}),
          },
          this.actor,
        );
        this.created++;
        return {
          id: t.id,
          message: `Task ${short(t.id)} created. It starts when its dependencies are done${dependsOn.length ? "" : " (it has none)"}.`,
        };
      }
      case "finding": {
        if (this.findings >= MAX_FINDINGS_PER_RUN)
          throw new OpsError("too many findings in this run");
        const text = str("text");
        if (!text) throw new OpsError("text is required");
        const f = await p.createConcept(
          { kind: "finding", parentId: this.taskId, title: firstLine(text), body: text },
          this.actor,
        );
        this.findings++;
        const n = await this.attachEvidence(f.id, args.evidence, ctx);
        if (!n) await p.link(f.id, "provenance", { type: "node", id: ctx.headNodeId }, this.actor);
        return {
          id: f.id,
          message: n
            ? `Finding ${short(f.id)} recorded with ${n} piece(s) of evidence.`
            : `Finding ${short(f.id)} recorded without evidence; it is shown as claimed. Attach a file or checkpoint next time.`,
        };
      }
      case "decision": {
        const text = str("text");
        if (!text) throw new OpsError("text is required");
        const d = await p.createConcept(
          {
            kind: "decision",
            parentId: this.taskId,
            title: firstLine(text),
            body: [text, str("rationale")].filter(Boolean).join("\n\n"),
          },
          this.actor,
        );
        return { id: d.id, message: `Decision ${short(d.id)} recorded.` };
      }
      case "question": {
        const text = str("text");
        if (!text) throw new OpsError("text is required");
        const options = Array.isArray(args.options)
          ? (args.options as unknown[]).map(String)
          : undefined;
        const q = await p.createConcept(
          {
            kind: "question",
            parentId: this.taskId,
            title: text,
            ...(options?.length ? { options } : {}),
          },
          this.actor,
        );
        await p.updateConcept(this.taskId, { status: "need_decision" }, { actor: this.actor });
        return {
          id: q.id,
          message:
            "Question recorded. End your turn now; the human will answer and you will continue.",
        };
      }
      case "brief": {
        const text = str("text");
        if (!text) throw new OpsError("text is required");
        await p.updateConcept(this.taskId, { brief: text }, { actor: this.actor });
        this.briefUpdated = true;
        return { message: "Brief updated." };
      }
      case "lesson": {
        const text = str("text");
        if (!text) throw new OpsError("text is required");
        const on = this.task.parentId ?? this.taskId;
        const l = await p.createConcept(
          {
            kind: "lesson",
            parentId: on,
            title: firstLine(text),
            body: text,
            lessonState: "proposed",
          },
          this.actor,
        );
        await p.link(l.id, "provenance", { type: "concept", id: this.taskId }, this.actor);
        await this.attachEvidence(l.id, args.evidence, ctx);
        return { id: l.id, message: `Lesson ${short(l.id)} proposed; a human will confirm it.` };
      }
    }
  }

  private async updateTask(args: Record<string, unknown>): Promise<GraphReply> {
    const p = this.project;
    const id = p.resolveConcept(String(args.id ?? "")).id;
    const t = p.getConcept(id) as Concept;
    const mine =
      id === this.taskId ||
      (t.createdBy.type === "agent" &&
        t.createdBy.onBehalfOf === this.project.identity.memberId &&
        this.isBelowTask(id));
    if (t.kind !== "task" || !mine)
      throw new OpsError("you may only update your own task or tasks you created");
    const fields: Partial<Concept> = {};
    if (typeof args.title === "string") fields.title = args.title;
    if (typeof args.body === "string") fields.body = args.body;
    if (Array.isArray(args.dependsOn))
      fields.dependsOn = (args.dependsOn as unknown[]).map((d) => p.resolveConcept(String(d)).id);
    if (args.status === "done" || args.status === "blocked") fields.status = args.status;
    if (!Object.keys(fields).length) throw new OpsError("nothing to update");
    const base = this.seen.get(id);
    await p.updateConcept(id, fields, {
      actor: this.actor,
      ...(base !== undefined ? { base } : {}),
    });
    return { id, message: "Task updated." };
  }

  private isBelowTask(id: string): boolean {
    let cur = this.project.getConcept(id);
    while (cur?.parentId) {
      if (cur.parentId === this.taskId) return true;
      cur = this.project.getConcept(cur.parentId);
    }
    return false;
  }

  private depthBelowTask(id: string): number {
    let depth = 0;
    let cur = this.project.getConcept(id);
    while (cur && cur.id !== this.taskId) {
      depth++;
      cur = cur.parentId ? this.project.getConcept(cur.parentId) : null;
    }
    if (!cur) throw new OpsError("subtasks must be under your task");
    return depth;
  }

  /** Evidence entries: files become outputs (path + sha256), checkpoints become node links. */
  private async attachEvidence(
    conceptId: string,
    raw: unknown,
    ctx: GraphCallContext,
  ): Promise<number> {
    if (!Array.isArray(raw)) return 0;
    let n = 0;
    for (const e of raw as Record<string, unknown>[]) {
      let target: LinkTarget | null = null;
      if (typeof e.checkpoint === "string" && e.checkpoint)
        target = { type: "node", id: e.checkpoint };
      else if (typeof e.path === "string" && e.path) {
        const abs = resolve(ctx.workspace, e.path);
        if (abs !== ctx.workspace && !abs.startsWith(ctx.workspace + sep)) continue;
        try {
          const [data, info] = await Promise.all([readFile(abs), stat(abs)]);
          const out = await this.project.createConcept(
            {
              kind: "output",
              parentId: this.taskId,
              title: relative(ctx.workspace, abs),
              path: relative(ctx.workspace, abs),
              sha256: createHash("sha256").update(data).digest("hex"),
              size: info.size,
            },
            this.actor,
          );
          target = { type: "concept", id: out.id };
        } catch {
          continue;
        }
      }
      if (target) {
        await this.project.link(conceptId, "evidence", target, this.actor);
        n++;
      }
    }
    return n;
  }
}

export interface TaskRunDeps {
  config: TurtleConfig;
  launcherFor: (sandbox: SandboxMode, config: TurtleConfig) => RunnerLauncher;
  summarizer: Summarizer;
  workspaceRoot?: string;
  onEvent?: (e: RunEvent) => void;
}

export interface TaskRun {
  session: RunSession;
  mode: RunSession["mode"];
  /** Release the source databases opened for the run (after `session.done`). */
  close(): void;
}

/**
 * Start (or continue) an agent on a task (docs/phase2-spec.md §7.2):
 * - the task's branch exists and is idle → continue it;
 * - the task starts from another task's checkpoint → fork from it;
 * - otherwise a new branch from the working copy.
 */
export async function startTaskRun(
  project: Project,
  taskId: string,
  deps: TaskRunDeps,
  o: { instruction?: string; sandbox?: SandboxMode; model?: string; maxBudgetUsd?: number } = {},
): Promise<TaskRun> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  if (task.status === "running") throw new OpsError("the task is already running");
  if (task.status === "abandoned" || task.status === "dropped")
    throw new OpsError(`the task is ${task.status}`);
  const primary =
    project.config.sources.find((s) => s.id === task.sources?.[0]) ?? project.config.sources[0];
  if (!primary) throw new OpsError("the project has no sources: turtle project add-source <repo>");
  const store = await GitStore.open(primary.path);
  const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
  const sources = await openRunSources(
    project,
    primary.path,
    task.sources?.filter((s) => s !== primary.id),
  );

  const opts: RunOptions = { prompt: "", sandbox: o.sandbox ?? deps.config.sandbox.mode };
  if (o.model) opts.model = o.model;
  if (o.maxBudgetUsd) opts.maxBudgetUsd = o.maxBudgetUsd;
  if (sources.companions.length && sources.primaryId) {
    opts.companions = sources.companions;
    opts.primarySourceId = sources.primaryId;
  }

  const own = task.branches?.find((b) => b.source === primary.id);
  const ownBranch = own ? db.getBranch(own.branch) : null;
  if (ownBranch?.headNodeId && ownBranch.status !== "running") {
    opts.from = ownBranch.headNodeId;
    const lessons = project.lessonsInScope(task.id);
    // Answers given since the last checkpoint of the previous run.
    const lastCp = project.db.listLinks({ from: task.id, rel: "evidence" }).at(-1)?.createdAt ?? "";
    const answers = project.db
      .listConcepts({ parentId: task.id, kind: "question" })
      .filter((q) => q.answer && q.answer.at >= lastCp)
      .map((q) => `- ${q.title} → ${q.answer?.text}`);
    opts.prompt = [
      o.instruction?.trim() ||
        (answers.length ? "The human answered your questions:" : "Continue the task."),
      answers.length ? `\n${answers.join("\n")}` : "",
      lessons.length
        ? `\nLessons in force:\n${lessons.map((l) => `- ${(l.body || l.title).replace(/\n+/g, " ")}`).join("\n")}`
        : "",
    ].join("");
  } else {
    if (task.startFrom) {
      let nodeId = task.startFrom.checkpointId;
      if (nodeId === "latest") {
        const fromTask = project.getConcept(task.startFrom.taskId);
        const b = fromTask?.branches?.find((x) => x.source === primary.id);
        const head = b ? db.getBranch(b.branch)?.headNodeId : null;
        nodeId = checkpointOf(db, head ? db.getNode(head) : null)?.id ?? "";
      }
      if (!nodeId || !db.getNode(nodeId)) {
        sources.close();
        db.close();
        throw new OpsError(`the checkpoint to start from is not in source ${primary.id}`);
      }
      opts.from = nodeId;
      opts.fork = true;
    }
    opts.prompt = assembleTaskContext(project, task.id, o.instruction);
  }

  const binding = new TaskRunBinding(project, task.id, primary.id);
  let session: RunSession;
  try {
    session = await RunSession.start(
      {
        store,
        db,
        config: deps.config,
        launcher: deps.launcherFor(opts.sandbox ?? deps.config.sandbox.mode, deps.config),
        summarizer: deps.summarizer,
        graph: binding,
        ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
        ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
      },
      opts,
    );
  } catch (err) {
    sources.close();
    db.close();
    throw err;
  }
  return {
    session,
    mode: session.mode,
    close() {
      sources.close();
      db.close();
    },
  };
}

function firstLine(s: string): string {
  const l = (s.split("\n")[0] ?? "").trim();
  return l.length > 160 ? `${l.slice(0, 159)}…` : l;
}

/** The agent currently running a task, found through its primary branch. */
async function runningAgentOf(project: Project, task: Concept) {
  for (const b of task.branches ?? []) {
    const source = project.config.sources.find((s) => s.id === b.source);
    if (!source) continue;
    const store = await GitStore.open(source.path);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    const agent = db
      .listAgents({ branchId: b.branch })
      .find((a) => a.status === "running" && a.adapter !== "companion");
    if (agent) return { store, db, agent, branchId: b.branch };
    db.close();
  }
  return null;
}

/**
 * Tell a running task's agent something (docs/phase2-spec.md §11): delivered at its
 * next tool boundary. Works across processes: the instruction goes through SQLite.
 */
export async function tellTask(
  project: Project,
  taskId: string,
  text: string,
): Promise<{ agentId: string }> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  if (!text.trim()) throw new OpsError("an instruction is required");
  const r = await runningAgentOf(project, task);
  if (!r) throw new OpsError("the task has no running agent; start it with an instruction instead");
  try {
    queueInstruction(r.db, {
      agentId: r.agent.id,
      branchId: r.branchId,
      text: text.trim(),
      from: project.identity.name,
    });
    return { agentId: r.agent.id };
  } finally {
    r.db.close();
  }
}

/** Pause (stop, keep the branch to continue later) or drop a running task. */
export async function stopTask(
  project: Project,
  taskId: string,
  o: { drop?: boolean } = {},
): Promise<{ stopped: boolean }> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  if (o.drop) await project.updateConcept(task.id, { status: "dropped" });
  const r = await runningAgentOf(project, task);
  if (!r) {
    if (!o.drop && task.status === "running")
      await project.updateConcept(task.id, { status: "paused" });
    return { stopped: false };
  }
  try {
    const branch = r.db.getBranch(r.branchId);
    if (branch) await requestStop(r.store, r.db, branch);
    return { stopped: true };
  } finally {
    r.db.close();
  }
}
