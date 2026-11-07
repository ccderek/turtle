import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Concept,
  GitStore,
  OpsError,
  type Project,
  type RunEvent,
  type RunnerLauncher,
  type RunSession,
  type SandboxMode,
  type Summarizer,
  startTaskRun,
  type TurtleConfig,
  uiOwnerFileFor,
} from "@turtle/core";

export interface TaskRunnerOptions {
  project: Project;
  config: TurtleConfig;
  launcherFor: (sandbox: SandboxMode, config: TurtleConfig) => RunnerLauncher;
  summarizer: Summarizer;
  workspaceRoot?: string;
  sessions: Map<string, RunSession>;
  onLog: (
    agentId: string,
    branchId: string,
    level: "info" | "warn" | "error",
    message: string,
  ) => void;
  log: (line: string) => void;
}

export interface StartTaskOptions {
  instruction?: string;
  sandbox?: SandboxMode;
  model?: string;
  budget?: number;
}

/**
 * Task runs inside `turtle ui` and the minimal scheduler (docs/phase2-spec.md §9):
 * ready tasks (todo, assigned to an agent, dependencies done) start on their own while
 * fewer than `maxParallel` task agents run here.
 */
export class TaskRunner {
  autoStart: boolean;
  private readonly taskOfAgent = new Map<string, string>();
  private starting = new Set<string>();
  private ticking = false;

  constructor(private readonly o: TaskRunnerOptions) {
    this.autoStart = o.project.config.defaults.autoStart ?? true;
  }

  get maxParallel(): number {
    return this.o.project.config.defaults.maxParallel ?? 3;
  }

  /** Task ids with an agent running in this process. */
  runningTasks(): Set<string> {
    return new Set([...this.taskOfAgent.values(), ...this.starting]);
  }

  async start(
    taskId: string,
    s: StartTaskOptions = {},
  ): Promise<{ agentId: string; mode: string }> {
    const { project, config, sessions } = this.o;
    if (this.runningTasks().has(taskId)) throw new OpsError("the task is already running");
    this.starting.add(taskId);
    let agentId = "";
    let branchId = "";
    const onEvent = (e: RunEvent) => {
      if (e.type === "started") {
        agentId = e.agentId;
        branchId = e.branch.id;
      } else if (e.type === "log" && e.level !== "info" && !e.message.startsWith("interrupting")) {
        this.o.onLog(agentId, branchId, e.level, e.message);
      }
    };
    try {
      const run = await startTaskRun(
        project,
        taskId,
        {
          config,
          launcherFor: this.o.launcherFor,
          summarizer: this.o.summarizer,
          onEvent,
          ...(this.o.workspaceRoot ? { workspaceRoot: this.o.workspaceRoot } : {}),
        },
        {
          ...(s.instruction ? { instruction: s.instruction } : {}),
          ...(s.sandbox ? { sandbox: s.sandbox } : {}),
          ...(s.model ? { model: s.model } : {}),
          ...(s.budget ? { maxBudgetUsd: s.budget } : {}),
        },
      );
      const session = run.session;
      const primary =
        project.config.sources.find((x) => x.id === project.getConcept(taskId)?.sources?.[0]) ??
        project.config.sources[0];
      const store = primary ? await GitStore.open(primary.path) : null;
      const ownerFile = store ? uiOwnerFileFor(store, session.agentId) : null;
      if (store && ownerFile) {
        await mkdir(join(store.turtleDir, "run"), { recursive: true });
        await writeFile(ownerFile, String(process.pid));
      }
      sessions.set(session.agentId, session);
      this.taskOfAgent.set(session.agentId, taskId);
      this.o.log(`task ${taskId} started (${run.mode}, agent ${session.agentId})`);
      void session.done.then(async (outcome) => {
        run.close();
        sessions.delete(session.agentId);
        this.taskOfAgent.delete(session.agentId);
        if (ownerFile) await rm(ownerFile, { force: true });
        this.o.log(`task ${taskId} ended: ${outcome.reason}`);
        void this.tick();
      });
      return { agentId: session.agentId, mode: run.mode };
    } finally {
      this.starting.delete(taskId);
    }
  }

  /** Ready tasks, oldest first. */
  ready(): Concept[] {
    const db = this.o.project.db;
    const running = this.runningTasks();
    return db
      .listConcepts({ kind: "task" })
      .filter(
        (t) =>
          (t.status ?? "todo") === "todo" && t.assignee?.type === "agent" && !running.has(t.id),
      )
      .filter((t) => (t.dependsOn ?? []).every((d) => db.getConcept(d)?.status === "done"))
      .filter((t) => !this.underInactive(t));
  }

  /** Why a todo task is not starting (shown on its card). */
  waitingReason(t: Concept): string | null {
    if ((t.status ?? "todo") !== "todo") return null;
    if (t.assignee?.type !== "agent") return "for you to do";
    const db = this.o.project.db;
    const open = (t.dependsOn ?? [])
      .map((d) => db.getConcept(d))
      .filter((d) => d && d.status !== "done");
    if (open.length) return `waiting for ${open.map((d) => `"${d?.title}"`).join(", ")}`;
    if (this.underInactive(t)) return "its parent is paused, dropped or abandoned";
    if (!this.autoStart) return "auto-start is off";
    if (this.runningTasks().size >= this.maxParallel)
      return `parallel cap ${this.maxParallel}/${this.maxParallel}`;
    return "starting";
  }

  private underInactive(t: Concept): boolean {
    let cur = t.parentId ? this.o.project.getConcept(t.parentId) : null;
    while (cur) {
      if (
        cur.kind === "task" &&
        (cur.status === "paused" || cur.status === "dropped" || cur.status === "abandoned")
      )
        return true;
      cur = cur.parentId ? this.o.project.getConcept(cur.parentId) : null;
    }
    return false;
  }

  /** Start ready tasks while there is room. Safe to call often. */
  async tick(): Promise<void> {
    if (!this.autoStart || this.ticking) return;
    this.ticking = true;
    try {
      for (const t of this.ready()) {
        if (this.runningTasks().size >= this.maxParallel) break;
        await this.start(t.id).catch((err: Error) => {
          this.o.log(`could not start task ${t.id}: ${err.message}`);
          return this.o.project.updateConcept(t.id, {
            status: "failed",
            brief: `Could not start: ${err.message}`,
          });
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}
