import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Concept,
  GitStore,
  type GraphTreeNode,
  graphTree,
  importAllSources,
  loadConfig,
  OpsError,
  type Project,
  pidFileFor,
  type SandboxMode,
  shortConceptIds,
  startTaskRun,
  TurtleDb,
} from "@turtle/core";
import { CliError } from "../context.js";
import { c, firstLine, truncate } from "../render.js";
import { requireProject } from "./project.js";
import { credentialHint, launcherFor, runEventPrinter, summarizerFor } from "./run.js";

async function withProject<T>(cwd: string, fn: (p: Project) => Promise<T>): Promise<T> {
  const p = await requireProject(cwd);
  try {
    await importAllSources(p);
    return await fn(p);
  } catch (err) {
    if (err instanceof OpsError) throw new CliError(err.message);
    throw err;
  } finally {
    p.close();
  }
}

const STATUS_MARK: Record<string, (s: string) => string> = {
  todo: (s) => c.dim(s),
  running: c.blue,
  need_decision: c.yellow,
  blocked: c.yellow,
  done: c.green,
  paused: (s) => c.dim(s),
  failed: c.red,
  abandoned: (s) => c.dim(s),
  dropped: (s) => c.dim(s),
};
const STATUS_ICON: Record<string, string> = {
  todo: "○",
  running: "●",
  need_decision: "?",
  blocked: "!",
  done: "✓",
  paused: "‖",
  failed: "✗",
  abandoned: "~",
  dropped: "⌀",
};
const KIND_LABEL: Record<string, string> = {
  lesson: "lesson",
  finding: "finding",
  decision: "decision",
  question: "question",
  output: "output",
};

export function conceptLine(n: Concept, short: (id: string) => string): string {
  const id = c.dim(short(n.id).padEnd(6));
  if (n.kind === "goal") return `${id} ${c.bold(n.title)}`;
  if (n.kind === "task") {
    const st = n.status ?? "todo";
    const paint = STATUS_MARK[st] ?? ((s: string) => s);
    const deps = n.dependsOn?.length ? c.dim(`  after ${n.dependsOn.map(short).join(", ")}`) : "";
    const from = n.startFrom ? c.dim(`  from ${short(n.startFrom.taskId)}`) : "";
    return `${id} ${paint(`${STATUS_ICON[st] ?? "·"} ${n.title}`)}  ${paint(c.dim(st))}${deps}${from}${n.dropped ? c.dim(" (dropped)") : ""}`;
  }
  const label = KIND_LABEL[n.kind] ?? n.kind;
  const answered =
    n.kind === "question" && n.answer ? c.dim(`  → ${truncate(n.answer.text, 50)}`) : "";
  return `${id} ${c.cyan(label)} ${truncate(n.title, 90)}${answered}`;
}

function render(nodes: GraphTreeNode[], short: (id: string) => string, prefix = ""): string[] {
  const out: string[] = [];
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const branch = prefix === "" && n.concept.kind === "goal" ? "" : last ? "└─ " : "├─ ";
    out.push(`${c.dim(prefix + branch)}${conceptLine(n.concept, short)}`);
    const next = prefix === "" && n.concept.kind === "goal" ? "" : prefix + (last ? "   " : "│  ");
    out.push(...render(n.children, short, next));
  });
  return out;
}

export async function graphCommand(
  cwd: string,
  o: { goal?: string; all?: boolean },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const short = shortConceptIds(p);
    const goalId = o.goal ? p.resolveConcept(o.goal).id : undefined;
    const trees = graphTree(p, { ...(goalId ? { goalId } : {}), includeDropped: o.all ?? false });
    if (!trees.length) return [c.dim('no goals yet: turtle goal "<what you want>"')];
    return trees.flatMap((t, i) => [...(i ? [""] : []), ...render([t], short)]);
  });
}

export async function goalCommand(
  cwd: string,
  text: string,
  o: { body?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const g = await p.createConcept({
      kind: "goal",
      parentId: null,
      title: firstLine(text),
      body: o.body ?? text.split("\n").slice(1).join("\n").trim(),
    });
    return [`goal ${c.bold(shortConceptIds(p)(g.id))} ${g.title}`];
  });
}

export async function taskAddCommand(
  cwd: string,
  title: string,
  o: { parent?: string; after?: string[]; from?: string; body?: string; noAgent?: boolean },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    let parentId: string;
    if (o.parent) parentId = p.resolveConcept(o.parent).id;
    else {
      const goals = p.db.listConcepts({ kind: "goal" });
      const latest = goals.at(-1);
      if (!latest) throw new CliError('no goal yet: turtle goal "<what you want>"');
      parentId = latest.id;
    }
    const startFromTask = o.from ? p.resolveConcept(o.from) : null;
    const t = await p.createConcept({
      kind: "task",
      parentId,
      title,
      ...(o.body ? { body: o.body } : {}),
      dependsOn: (o.after ?? []).map((a) => p.resolveConcept(a).id),
      assignee: o.noAgent ? { type: "member", id: p.identity.memberId } : { type: "agent" },
      ...(startFromTask ? { startFrom: { taskId: startFromTask.id, checkpointId: "latest" } } : {}),
    });
    return [`task ${c.bold(shortConceptIds(p)(t.id))} ${t.title}  ${c.dim(t.status ?? "")}`];
  });
}

export async function taskShowCommand(cwd: string, ref: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const short = shortConceptIds(p);
    const n = p.resolveConcept(ref);
    const out = [
      conceptLine(n, short),
      c.dim(`${n.id}  v${n.version}  by ${n.createdBy.id}  ${n.createdAt}`),
    ];
    if (n.body) out.push("", ...n.body.split("\n").map((l) => `  ${l}`));
    if (n.brief) out.push("", c.bold("brief"), ...n.brief.split("\n").map((l) => `  ${l}`));
    if (n.branches?.length)
      out.push("", `code   ${n.branches.map((b) => `${b.source}:${b.branch}`).join(", ")}`);
    const links = p.db.listLinks({ from: n.id });
    if (links.length)
      out.push("", c.bold("links"), ...links.map((l) => `  ${l.rel} → ${l.to.type} ${l.to.id}`));
    const ops = p.db.listOps({ concept: n.id });
    out.push("", c.bold("history"));
    for (const op of ops)
      out.push(c.dim(`  ${op.id.slice(0, 10)}  ${op.at}  ${op.actor.id}  ${op.change.kind}`));
    return out;
  });
}

export async function taskDropCommand(cwd: string, ref: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const n = p.resolveConcept(ref);
    await p.dropConcept(n.id);
    return [
      `dropped ${n.title}  ${c.dim("(undo: turtle undo with its operation id, see turtle task show)")}`,
    ];
  });
}

export async function answerCommand(cwd: string, ref: string, text: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const d = await p.answerQuestion(p.resolveConcept(ref).id, text);
    return [`answered; decision ${shortConceptIds(p)(d.id)} recorded`];
  });
}

export async function undoCommand(cwd: string, opRef: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const op = p.db.listOps().find((o) => o.id.startsWith(opRef));
    if (!op) throw new CliError(`unknown operation: ${opRef}`);
    const inverse = await p.undo(op.id);
    return [
      `undid ${op.change.kind} (${inverse.length} inverse operation${inverse.length === 1 ? "" : "s"})`,
    ];
  });
}

// ------------------------------------------------------------- task runs

export interface TaskStartOptions {
  message?: string;
  sandbox?: SandboxMode;
  model?: string;
  budget?: string;
  verbose?: boolean;
}

/** `turtle task start`: run (or continue) the task's agent in this terminal. */
export async function taskStartCommand(
  cwd: string,
  ref: string,
  o: TaskStartOptions,
): Promise<number> {
  const p = await requireProject(cwd);
  const opened: { close(): void }[] = [p];
  try {
    await importAllSources(p);
    const task = p.resolveConcept(ref);
    const primary = p.config.sources.find((s) => s.id === task.sources?.[0]) ?? p.config.sources[0];
    if (!primary)
      throw new CliError("the project has no sources: turtle project add-source <repo>");
    const config = await loadConfig(primary.path);
    if (p.config.defaults.sandbox) config.sandbox.mode = p.config.defaults.sandbox;
    if (p.config.defaults.model) config.agent.model = p.config.defaults.model;
    const sandbox = o.sandbox ?? config.sandbox.mode;
    const store = await GitStore.open(primary.path);
    const printDb = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    opened.push(printDb);
    const hint = credentialHint(sandbox);
    if (hint) process.stdout.write(`${c.yellow(hint)}\n`);
    const budget = o.budget ? Number(o.budget) : undefined;
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0))
      throw new CliError(`invalid --budget: ${o.budget}`);
    const run = await startTaskRun(
      p,
      task.id,
      {
        config,
        launcherFor,
        summarizer: summarizerFor(config, (m) => process.stdout.write(`${c.yellow(m)}\n`)),
        onEvent: runEventPrinter(printDb, sandbox, o.verbose ?? false),
      },
      {
        sandbox,
        ...(o.message ? { instruction: o.message } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(budget ? { maxBudgetUsd: budget } : {}),
      },
    );
    opened.push(run);
    const pidFile = pidFileFor(store, run.session.agentId);
    await mkdir(join(store.turtleDir, "run"), { recursive: true });
    await writeFile(pidFile, String(process.pid));
    const onSignal = () => run.session.interrupt();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const outcome = await run.session.done;
      const after = p.getConcept(task.id);
      process.stdout.write(
        `task ${c.bold(shortConceptIds(p)(task.id))} ${task.title}: ${after?.status ?? "?"}\n`,
      );
      return outcome.reason === "failed" ? 1 : outcome.reason === "killed" ? 130 : 0;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await rm(pidFile, { force: true });
    }
  } catch (err) {
    if (err instanceof OpsError) throw new CliError(err.message);
    throw err;
  } finally {
    for (const x of opened.reverse()) x.close();
  }
}

export async function taskAbandonCommand(
  cwd: string,
  ref: string,
  o: { lesson?: string; on?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const t = p.resolveConcept(ref);
    if (t.status === "running")
      throw new CliError("the task is running; stop it first (turtle stop <branch>)");
    const { lesson } = await p.abandonTask(t.id, {
      ...(o.lesson ? { lesson: o.lesson } : {}),
      ...(o.on ? { on: p.resolveConcept(o.on).id } : {}),
    });
    const short = shortConceptIds(p);
    const on = lesson.parentId ? p.getConcept(lesson.parentId) : null;
    return [
      `abandoned ${t.title} (kept in the record)`,
      `lesson ${c.bold(short(lesson.id))} on "${on?.title ?? "?"}" ${c.dim(`[${lesson.lessonState}]`)}`,
      ...(lesson.body ?? "").split("\n").map((l) => c.dim(`  ${l}`)),
      lesson.lessonState === "proposed"
        ? c.dim(`edit or confirm: turtle lesson confirm ${short(lesson.id)} [--text "<lesson>"]`)
        : "",
      c.dim(`retry: turtle task retry ${short(on?.id ?? "")} "<another way>"`),
    ].filter(Boolean);
  });
}

export async function taskRetryCommand(
  cwd: string,
  ref: string,
  title: string,
  o: { from?: string; body?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const parent = p.resolveConcept(ref);
    const t = await p.retryTask(parent.id, title, {
      ...(o.body ? { body: o.body } : {}),
      ...(o.from ? { from: { taskId: parent.id, checkpointId: o.from } } : {}),
    });
    const short = shortConceptIds(p);
    const lessons = p.lessonsInScope(t.id).length;
    return [
      `task ${c.bold(short(t.id))} ${t.title}  ${c.dim(t.startFrom ? `starts from ${t.startFrom.checkpointId.slice(0, 6)}` : "starts fresh")}`,
      c.dim(
        `inherits ${lessons} lesson${lessons === 1 ? "" : "s"}; start it: turtle task start ${short(t.id)}`,
      ),
    ];
  });
}

export async function lessonCommand(
  cwd: string,
  action: "add" | "confirm" | "supersede",
  ref: string,
  o: { text?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const short = shortConceptIds(p);
    if (action === "add") {
      if (!o.text) throw new CliError("--text is required");
      const l = await p.createConcept({
        kind: "lesson",
        parentId: p.resolveConcept(ref).id,
        title: firstLine(o.text),
        body: o.text,
        lessonState: "confirmed",
      });
      return [`lesson ${c.bold(short(l.id))} added`];
    }
    const l = p.resolveConcept(ref);
    if (l.kind !== "lesson") throw new CliError(`${ref} is not a lesson`);
    await p.updateConcept(l.id, {
      lessonState: action === "confirm" ? "confirmed" : "superseded",
      ...(o.text ? { body: o.text, title: firstLine(o.text) } : {}),
    });
    return [`lesson ${short(l.id)} ${action === "confirm" ? "confirmed" : "superseded"}`];
  });
}
