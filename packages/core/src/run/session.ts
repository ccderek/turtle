import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type {
  CheckpointReply,
  CheckpointRequest,
  CheckpointStatus,
  DiffReply,
  FromRunner,
  HistoryEntry,
  PostToolUseRequest,
  RunnerRequest,
  RunnerStartOptions,
} from "@turtle/protocol";
import type { TurtleConfig } from "../config.js";
import type { TurtleDb } from "../db/db.js";
import type {
  AgentStatus,
  Branch,
  BranchStatus,
  NodeKind,
  NodeStatus,
  SandboxMode,
  SummarySource,
  TestStatus,
  TurtleNode,
} from "../db/types.js";
import type { Trailers } from "../git/message.js";
import { AGENT_IDENTITY, BRANCH_REF_PREFIX, type GitStore } from "../git/store.js";
import { newId } from "../ids.js";
import { checkpointReplyMessage, contextPrefix, TURTLE_SYSTEM_PROMPT } from "./prompt.js";
import { detectTestResult, evaluateRules, isMutatingTool } from "./rules.js";
import { type Summarizer, type Summary, type SummaryInput, truncate } from "./summarizer.js";
import type { RunnerLauncher, RunnerTransport } from "./transport.js";
import { UsageTracker } from "./usage.js";

const MAX_DIFF_CHARS = 30_000;
const SUMMARY_DIFF_CHARS = 20_000;
const KILL_GRACE_MS = 10_000;

export interface RunOptions {
  prompt: string;
  /** Full node id to continue or fork from; omit for a new branch from the working copy. */
  from?: string;
  /** Always create a new branch, even from a branch head. */
  fork?: boolean;
  /** New branch from HEAD, ignoring uncommitted changes. */
  fromHead?: boolean;
  name?: string;
  sandbox?: SandboxMode;
  model?: string;
  maxBudgetUsd?: number;
}

export interface RunDeps {
  store: GitStore;
  db: TurtleDb;
  config: TurtleConfig;
  launcher: RunnerLauncher;
  summarizer: Summarizer;
  /** Where workspaces live (default ~/.turtle/workspaces/<repoId>). */
  workspaceRoot?: string;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
  /** Subscribed before anything is emitted, so it also sees "started". */
  onEvent?: (event: RunEvent) => void;
}

export type RunMode = "new" | "continue" | "fork";

export type EndReason = "done" | "need_decision" | "blocked" | "killed" | "failed";

export interface RunOutcome {
  agentId: string;
  branchId: string;
  reason: EndReason;
  headNodeId: string;
  lastSemanticNodeId: string | null;
  costUsd: number | null;
  numTurns: number | null;
  error?: string;
}

export type RunEvent =
  | {
      type: "started";
      mode: RunMode;
      branch: Branch;
      agentId: string;
      root: TurtleNode;
      resumed: boolean;
    }
  | { type: "assistant_text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "node"; node: TurtleNode }
  | { type: "tests"; status: TestStatus }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "result"; costUsd: number | null; numTurns: number | null; isError: boolean }
  | { type: "ended"; outcome: RunOutcome };

interface Head {
  nodeId: string;
  commit: string;
  tree: string;
}

interface SemanticMark {
  nodeId: string;
  tree: string;
  at: number;
  status: NodeStatus;
  tests: TestStatus | null;
  inThisRun: boolean;
}

interface NodeParams {
  kind: NodeKind;
  title: string;
  body?: string;
  summarySource: SummarySource | null;
  status: NodeStatus;
  trigger: string;
  allowUnchanged: boolean;
  resumeToolUseId: string | null;
  eventPayload?: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: SDK messages are untyped JSON here.
type SdkMessage = any;

/** Short hash identifying a repository (used for the workspace directory). */
export function repoIdFor(store: GitStore): string {
  return createHash("sha1").update(store.commonDir).digest("hex").slice(0, 10);
}

export function turtleHome(): string {
  return process.env.TURTLE_HOME ?? join(homedir(), ".turtle");
}

/**
 * One agent working on one branch: the orchestrator for a single `turtle run`
 * (docs/phase0-spec.md §3, §10, §13).
 */
export class RunSession extends EventEmitter<{ event: [RunEvent] }> {
  readonly done: Promise<RunOutcome>;
  private resolveDone!: (o: RunOutcome) => void;

  private transport!: RunnerTransport;
  private head!: Head;
  private lastSemantic!: SemanticMark;
  private toolCallsSinceSemantic = 0;
  private toolLog: { name: string; input: string }[] = [];
  private lastAssistantText: string | null = null;
  private testsNow: TestStatus | null = null;
  private sessionId: string | null = null;
  private result: { subtype: string; costUsd: number | null; numTurns: number | null } | null =
    null;
  private interrupted = false;
  private finalized = false;
  private exited = false;
  private killTimer: NodeJS.Timeout | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly usage: UsageTracker;
  private readonly now: () => number;
  private readonly pendingExec = new Map<
    number,
    (r: { exitCode: number; stdout: string }) => void
  >();
  private execSeq = 0;
  /** API message id → tool_use ids it contains (main thread only). */
  private readonly toolGroups = new Map<string, Set<string>>();
  private readonly groupOfTool = new Map<string, string>();
  private readonly toolResultsSeen = new Set<string>();
  /** tool_use id → uuid of the message that completed its group. */
  private readonly resumeUuidByTool = new Map<string, string>();

  private constructor(
    private readonly deps: RunDeps,
    private readonly opts: RunOptions,
    readonly mode: RunMode,
    public branch: Branch,
    readonly agentId: string,
    readonly workspace: string,
  ) {
    super();
    this.usage = new UsageTracker(deps.config.prices);
    this.now = deps.now ?? Date.now;
    if (deps.onEvent) this.on("event", deps.onEvent);
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  get branchId(): string {
    return this.branch.id;
  }

  // ------------------------------------------------------------------ start

  static async start(deps: RunDeps, opts: RunOptions): Promise<RunSession> {
    const { store, db, config } = deps;
    const workspaceRoot = deps.workspaceRoot ?? join(turtleHome(), "workspaces", repoIdFor(store));
    const sandbox = opts.sandbox ?? config.sandbox.mode;
    const agentId = newId();

    let mode: RunMode;
    let branch: Branch;
    let headNode: TurtleNode;
    let workspace: string;
    let resume: Pick<RunnerStartOptions, "resume" | "resumeSessionAt" | "forkSession"> = {};
    let promptPrefix = "";

    if (!opts.from) {
      mode = "new";
      const branchId = newId();
      const rootId = newId();
      const ref = `${BRANCH_REF_PREFIX}${branchId}`;
      const root = await store.snapshotWorkingCopy({
        indexFile: join(store.turtleDir, "index", `root-${branchId}`),
        message: {
          title: "root",
          trailers: {
            "Turtle-Node": rootId,
            "Turtle-Kind": "root",
            "Turtle-Status": "done",
            "Turtle-Branch": branchId,
          },
        },
        identity: await store.userIdentity(),
        fromHead: opts.fromHead ?? false,
      });
      await store.updateRef(ref, root.commit, null);
      workspace = join(workspaceRoot, branchId);
      const headLabel = root.head ? root.head.slice(0, 7) : "(no commits)";
      branch = db.transaction(() => {
        const b = db.insertBranch({
          id: branchId,
          name: opts.name ?? null,
          ref,
          rootNodeId: rootId,
          forkedFromNodeId: null,
          headNodeId: rootId,
          workspacePath: workspace,
          status: "running",
        });
        db.insertNode(
          blankNode({
            id: rootId,
            branchId,
            kind: "root",
            commitSha: root.commit,
            treeSha: root.tree,
            summary: `root: HEAD ${headLabel}${root.dirty ? " + uncommitted changes" : ""}`,
            status: "done",
            trigger: "root",
          }),
        );
        return b;
      });
      headNode = db.getNode(rootId) as TurtleNode;
      await store.materialize(root.commit, workspace, store.indexFileFor(branchId));
      await copyIgnored(store.topLevel, workspace, config.workspace.copyIgnored);
    } else {
      const from = db.getNode(opts.from);
      if (!from) throw new Error(`unknown node: ${opts.from}`);
      const fromBranch = db.getBranch(from.branchId);
      if (!fromBranch) throw new Error(`node ${from.id} has no branch`);
      const isHead = fromBranch.headNodeId === from.id;
      if (!opts.fork && isHead && fromBranch.status !== "running") {
        mode = "continue";
        branch = fromBranch;
        headNode = from;
        workspace = fromBranch.workspacePath ?? join(workspaceRoot, fromBranch.id);
        if (!(await exists(workspace))) {
          await store.materialize(from.commitSha, workspace, store.indexFileFor(branch.id));
          await copyIgnored(store.topLevel, workspace, config.workspace.copyIgnored);
        }
        db.updateBranch(branch.id, { status: "running", workspacePath: workspace });
        const sessionId = from.sessionId ?? lastSessionOf(db, branch.id);
        if (sessionId) resume = { resume: sessionId };
      } else {
        if (!opts.fork && fromBranch.status === "running" && isHead) {
          throw new Error(`branch ${fromBranch.id} is running; use --fork to branch off it`);
        }
        mode = "fork";
        const branchId = newId();
        const ref = `${BRANCH_REF_PREFIX}${branchId}`;
        await store.updateRef(ref, from.commitSha, null);
        workspace = join(workspaceRoot, branchId);
        branch = db.insertBranch({
          id: branchId,
          name: opts.name ?? null,
          ref,
          rootNodeId: from.id,
          forkedFromNodeId: from.id,
          headNodeId: from.id,
          workspacePath: workspace,
          status: "running",
        });
        headNode = from;
        await store.materialize(from.commitSha, workspace, store.indexFileFor(branchId));
        await copyIgnored(store.topLevel, workspace, config.workspace.copyIgnored);
        if (from.sessionId && from.resumeMessageUuid) {
          resume = {
            resume: from.sessionId,
            resumeSessionAt: from.resumeMessageUuid,
            forkSession: true,
          };
        }
      }
      if (!resume.resume && from.kind !== "root") {
        promptPrefix = contextPrefix(semanticAncestors(db, from.id, 10));
      }
    }

    db.insertAgent({
      id: agentId,
      branchId: branch.id,
      adapter: config.agent.adapter,
      adapterLevel: 2,
      model: opts.model ?? config.agent.model ?? null,
      sandbox,
      sessionId: null,
      prompt: opts.prompt,
      status: "starting",
      pid: process.pid,
    });
    db.appendEvent({
      actorType: "human",
      actorId: null,
      type: mode === "fork" ? "fork" : "run_start",
      branchId: branch.id,
      nodeId: headNode.id,
      agentId,
      payload: { mode, prompt: opts.prompt, resumed: Boolean(resume.resume) },
    });

    const session = new RunSession(deps, opts, mode, branch, agentId, workspace);
    session.head = { nodeId: headNode.id, commit: headNode.commitSha, tree: headNode.treeSha };
    const sem = lastSemanticAncestor(db, headNode);
    session.lastSemantic = {
      nodeId: sem.id,
      tree: sem.treeSha,
      at: session.now(),
      status: sem.status,
      tests: sem.tests,
      inThisRun: false,
    };
    session.testsNow = sem.tests;

    const startOptions: RunnerStartOptions = {
      systemPromptAppend: TURTLE_SYSTEM_PROMPT,
      permissionMode: sandbox === "docker" ? "bypassPermissions" : "acceptEdits",
      allowedTools: config.agent.allowedTools,
      ...resume,
    };
    const model = opts.model ?? config.agent.model;
    if (model) startOptions.model = model;
    if (config.agent.maxTurns) startOptions.maxTurns = config.agent.maxTurns;
    const budget = opts.maxBudgetUsd ?? config.agent.maxBudgetUsd;
    if (budget) startOptions.maxBudgetUsd = budget;
    if (config.workspace.setupCommand && mode !== "continue")
      startOptions.setupCommand = config.workspace.setupCommand;

    session.emit("event", {
      type: "started",
      mode,
      branch,
      agentId,
      root: headNode,
      resumed: Boolean(resume.resume),
    });

    const transport = await deps.launcher({
      agentId,
      branchId: branch.id,
      workspace,
      sandbox,
      claudeConfigDir: join(store.turtleDir, "claude"),
      logFile: join(store.turtleDir, "logs", `${agentId}.log`),
      env: {},
    });
    session.transport = transport;
    transport.onMessage((msg) =>
      session.onRunnerMessage(msg, `${promptPrefix}${opts.prompt}`, startOptions),
    );
    transport.onClose((code) => {
      void session.onExit(code ?? -1, "runner closed");
    });
    db.updateAgent(agentId, { status: "running" });
    return session;
  }

  // ------------------------------------------------------------- interrupt

  /** First call: ask the runner to stop. Second call (or after 10 s): kill it. */
  interrupt(): void {
    if (this.exited) return;
    if (this.interrupted) {
      this.transport.kill();
      return;
    }
    this.interrupted = true;
    this.log("warn", "interrupting agent…");
    this.transport.send({ t: "interrupt" });
    this.killTimer = setTimeout(() => this.transport.kill(), KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  // -------------------------------------------------------- runner messages

  private onRunnerMessage(msg: FromRunner, prompt: string, options: RunnerStartOptions): void {
    switch (msg.t) {
      case "ready":
        this.transport.send({ t: "start", prompt, options });
        return;
      case "sdk":
        this.onSdk(msg.msg as SdkMessage);
        return;
      case "request":
        this.handleRequest(msg).then(
          (result) => this.transport.send({ t: "reply", id: msg.id, ok: true, result }),
          (err: unknown) => {
            this.log("error", `${msg.kind} failed: ${errorMessage(err)}`);
            this.transport.send({ t: "reply", id: msg.id, ok: false, error: errorMessage(err) });
          },
        );
        return;
      case "exec_result":
        this.pendingExec.get(msg.id)?.({ exitCode: msg.exitCode, stdout: msg.stdout });
        this.pendingExec.delete(msg.id);
        return;
      case "log":
        this.log(msg.level, msg.message);
        return;
      case "exit":
        void this.onExit(msg.code, msg.error);
        return;
    }
  }

  private onSdk(m: SdkMessage): void {
    const { db } = this.deps;
    if (!m || typeof m !== "object") return;
    db.appendMessage(this.agentId, {
      sessionId: m.session_id ?? null,
      uuid: m.uuid ?? null,
      type: String(m.type ?? "unknown"),
      parentToolUseId: m.parent_tool_use_id ?? null,
      json: JSON.stringify(m),
    });
    const main = !m.parent_tool_use_id;

    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      this.sessionId = m.session_id;
      db.updateAgent(this.agentId, { sessionId: m.session_id });
    } else if (m.type === "assistant" && m.message) {
      const apiId = String(m.message.id ?? m.uuid ?? newId());
      this.usage.add(apiId, m.message.usage, m.message.model ?? null);
      for (const block of contentBlocks(m.message.content)) {
        if (block.type === "text" && main && typeof block.text === "string" && block.text.trim()) {
          this.lastAssistantText = block.text;
          this.emit("event", { type: "assistant_text", text: block.text });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          if (main) {
            let group = this.toolGroups.get(apiId);
            if (!group) {
              group = new Set();
              this.toolGroups.set(apiId, group);
            }
            group.add(block.id);
            this.groupOfTool.set(block.id, apiId);
          }
          this.emit("event", {
            type: "tool",
            name: String(block.name),
            detail: toolDetail(block.input),
          });
        }
      }
    } else if (m.type === "user" && main && m.message && typeof m.uuid === "string") {
      for (const block of contentBlocks(m.message.content)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          this.toolResultsSeen.add(block.tool_use_id);
        }
      }
      this.completeToolGroups(m.uuid);
    } else if (m.type === "result") {
      this.result = {
        subtype: String(m.subtype ?? "unknown"),
        costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
        numTurns: typeof m.num_turns === "number" ? m.num_turns : null,
      };
      if (m.session_id && !this.sessionId) this.sessionId = m.session_id;
      this.emit("event", {
        type: "result",
        costUsd: this.result.costUsd,
        numTurns: this.result.numTurns,
        isError: Boolean(m.is_error),
      });
    }
  }

  /**
   * A resume point must follow every tool_result of an assistant turn
   * (docs/phase0-spec.md §10). When all tool calls of a turn have results, record
   * `uuid` as the resume point for nodes created by those calls.
   */
  private completeToolGroups(uuid: string): void {
    for (const [apiId, group] of this.toolGroups) {
      if (![...group].every((id) => this.toolResultsSeen.has(id))) continue;
      for (const toolId of group) {
        this.resumeUuidByTool.set(toolId, uuid);
        this.deps.db.resolveResumePoint(this.agentId, toolId, uuid);
        this.groupOfTool.delete(toolId);
      }
      this.toolGroups.delete(apiId);
    }
  }

  // --------------------------------------------------------------- requests

  private async handleRequest(req: RunnerRequest): Promise<unknown> {
    switch (req.kind) {
      case "post_tool_use":
        return this.onPostToolUse(req);
      case "checkpoint":
        return this.onCheckpoint(req);
      case "diff":
        return this.onDiff(req.since, req.path);
      case "history":
        return semanticAncestors(
          this.deps.db,
          this.head.nodeId,
          req.limit ?? 20,
        ) satisfies HistoryEntry[];
      case "stop":
        await this.finalize(this.interrupted ? "interrupt" : "stop");
        return { ok: true };
    }
  }

  private async onPostToolUse(req: PostToolUseRequest): Promise<{ ok: true }> {
    const { db, config } = this.deps;
    const turtleTool = req.toolName.startsWith("mcp__turtle__");
    if (!turtleTool) {
      this.toolCallsSinceSemantic++;
      this.toolLog.push({ name: req.toolName, input: toolDetail(req.toolInput) });
    }
    db.appendEvent({
      actorType: "agent",
      actorId: this.agentId,
      type: "tool_call",
      branchId: this.branchId,
      nodeId: null,
      agentId: this.agentId,
      payload: { tool: req.toolName, toolUseId: req.toolUseId, subagent: req.agentId ?? null },
    });
    const tests = detectTestResult(
      config.tests.command,
      req.toolName,
      req.toolInput,
      req.toolResponse,
    );
    if (tests) {
      this.testsNow = tests;
      this.emit("event", { type: "tests", status: tests });
    }
    const resumeToolUseId = req.agentId ? null : req.toolUseId;
    if (isMutatingTool(req.toolName)) {
      await this.createNode({
        kind: "micro",
        title: `micro: after ${req.toolName}`,
        summarySource: null,
        status: "progress",
        trigger: `tool:${req.toolName}`,
        allowUnchanged: false,
        resumeToolUseId,
      });
    }
    if (!turtleTool && !this.finalized) {
      const stat = await this.deps.store.diffStat(this.lastSemantic.tree, this.head.tree);
      const rule = evaluateRules(
        {
          toolCalls: this.toolCallsSinceSemantic,
          elapsedMs: this.now() - this.lastSemantic.at,
          changedLines: stat.linesAdded + stat.linesDeleted,
          changedFiles: stat.filesChanged,
          testsAtCheckpoint: this.lastSemantic.tests,
          testsNow: this.testsNow,
        },
        config.checkpoint.rules,
      );
      if (rule) await this.autoCheckpoint(`rule:${rule}`, "progress", resumeToolUseId);
    }
    return { ok: true };
  }

  private async onCheckpoint(req: CheckpointRequest): Promise<CheckpointReply> {
    const { db, store } = this.deps;
    await this.runTestsIfConfigured();
    const [title = "", ...rest] = req.summary.trim().split("\n");
    const node = await this.createNode({
      kind: "semantic",
      title: title || "(no summary)",
      body: rest.join("\n").trim(),
      summarySource: "agent_declared",
      status: req.status,
      trigger: "declared",
      allowUnchanged: true,
      resumeToolUseId: req.toolUseId ?? null,
    });
    if (!node) throw new Error("checkpoint was not recorded");
    for (const a of req.artifacts ?? []) {
      const abs = resolve(this.workspace, a.path);
      if (abs !== this.workspace && !abs.startsWith(this.workspace + sep)) {
        this.log("warn", `artifact outside workspace ignored: ${a.path}`);
        continue;
      }
      try {
        const info = await fsStat(abs);
        const blobSha = await store.hashFile(abs);
        db.insertArtifact({
          nodeId: node.id,
          label: a.label ?? null,
          path: relative(this.workspace, abs),
          blobSha,
          mime: null,
          size: info.size,
        });
      } catch (err) {
        this.log("warn", `artifact ${a.path} not stored: ${errorMessage(err)}`);
      }
    }
    return { nodeId: node.id, message: checkpointReplyMessage(node.id.slice(0, 6), req.status) };
  }

  private async onDiff(since: string | undefined, path: string | undefined): Promise<DiffReply> {
    const { db, store } = this.deps;
    let fromTree: string;
    if (!since || since === "branch_start") {
      fromTree = db.getNode(this.branch.rootNodeId)?.treeSha ?? (await store.emptyTree());
    } else if (since === "last_checkpoint") {
      fromTree = this.lastSemantic.tree;
    } else {
      const n = db.getNode(since) ?? db.findNodesByPrefix(since, 2).at(0);
      if (!n) throw new Error(`unknown node ${since}`);
      fromTree = n.treeSha;
    }
    const diff = await store.diff(fromTree, this.head.tree, path ? [path] : []);
    const truncated = diff.length > MAX_DIFF_CHARS;
    return {
      diff: truncated
        ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated (${diff.length} chars)`
        : diff,
      truncated,
    };
  }

  // ------------------------------------------------------------------ nodes

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private createNode(p: NodeParams): Promise<TurtleNode | null> {
    return this.withLock(async () => {
      const { store, db } = this.deps;
      const id = newId();
      const trailers: Trailers = {
        "Turtle-Node": id,
        "Turtle-Kind": p.kind,
        "Turtle-Status": p.status,
        "Turtle-Branch": this.branchId,
        "Turtle-Agent": this.agentId,
        "Turtle-Trigger": p.trigger,
      };
      if (p.summarySource) trailers["Turtle-Summary-Source"] = p.summarySource;
      const res = await store.snapshot({
        workTree: this.workspace,
        indexFile: store.indexFileFor(this.branchId),
        parent: { commit: this.head.commit, tree: this.head.tree },
        message: p.body ? { title: p.title, body: p.body, trailers } : { title: p.title, trailers },
        identity: AGENT_IDENTITY,
        allowUnchanged: p.allowUnchanged,
        ref: { name: this.branch.ref, expectedOld: this.head.commit },
      });
      if (!res) return null;
      const { tokens, costUsd } = this.usage.drain();
      const summary = p.kind === "micro" ? p.title : p.body ? `${p.title}\n\n${p.body}` : p.title;
      const node = db.transaction(() => {
        const n = db.insertNode(
          blankNode({
            id,
            branchId: this.branchId,
            agentId: this.agentId,
            kind: p.kind,
            parents: [this.head.nodeId],
            commitSha: res.commit,
            treeSha: res.tree,
            intent: this.opts.prompt,
            summary,
            summarySource: p.summarySource,
            status: p.status,
            trigger: p.trigger,
            sessionId: this.sessionId,
            resumeToolUseId: p.resumeToolUseId,
            resumeMessageUuid: p.resumeToolUseId
              ? (this.resumeUuidByTool.get(p.resumeToolUseId) ?? null)
              : null,
            tests: this.testsNow,
            filesChanged: res.stat.filesChanged,
            linesAdded: res.stat.linesAdded,
            linesDeleted: res.stat.linesDeleted,
            tokens,
            costUsdEst: costUsd,
          }),
        );
        db.attachPendingMessages(this.agentId, id);
        db.updateBranch(this.branchId, { headNodeId: id });
        db.appendEvent({
          actorType: p.summarySource === "agent_declared" ? "agent" : "system",
          actorId: this.agentId,
          type: "checkpoint",
          branchId: this.branchId,
          nodeId: id,
          agentId: this.agentId,
          payload: {
            kind: p.kind,
            trigger: p.trigger,
            snapshotMs: Math.round(res.durationMs),
            ...p.eventPayload,
          },
        });
        return n;
      });
      this.head = { nodeId: id, commit: res.commit, tree: res.tree };
      if (p.kind === "semantic") {
        this.lastSemantic = {
          nodeId: id,
          tree: res.tree,
          at: this.now(),
          status: p.status,
          tests: this.testsNow,
          inThisRun: true,
        };
        this.toolCallsSinceSemantic = 0;
        this.toolLog = [];
      }
      this.emit("event", { type: "node", node });
      return node;
    });
  }

  private async autoCheckpoint(
    trigger: string,
    status: NodeStatus,
    resumeToolUseId: string | null,
  ): Promise<TurtleNode | null> {
    await this.runTestsIfConfigured();
    const input = await this.summaryInput(trigger);
    let summary: Summary;
    try {
      summary = await this.deps.summarizer.summarize(input);
    } catch (err) {
      this.log("warn", `summarizer failed, using a plain summary: ${errorMessage(err)}`);
      summary = { title: `Auto checkpoint (${trigger})`, body: "" };
    }
    return this.createNode({
      kind: "semantic",
      title: truncate(summary.title, 72),
      body: summary.body,
      summarySource: "rule_auto",
      status,
      trigger,
      allowUnchanged: true,
      resumeToolUseId,
      eventPayload: summary.usage ? { summarizer: summary.usage } : {},
    });
  }

  private async summaryInput(trigger: string): Promise<SummaryInput> {
    const { store } = this.deps;
    const from = this.lastSemantic.tree;
    const to = this.head.tree;
    const [stat, diff, names] = await Promise.all([
      store.diffStat(from, to),
      store.diff(from, to),
      from === to
        ? Promise.resolve("")
        : store.run(["diff-tree", "-r", "--name-only", "--no-renames", from, to]),
    ]);
    return {
      intent: this.opts.prompt,
      trigger,
      stat,
      changedPaths: names ? names.split("\n") : [],
      diff: diff.length > SUMMARY_DIFF_CHARS ? `${diff.slice(0, SUMMARY_DIFF_CHARS)}\n…` : diff,
      toolCalls: this.toolLog.slice(-50),
      lastAssistantText: this.lastAssistantText,
    };
  }

  private async runTestsIfConfigured(): Promise<void> {
    const { tests } = this.deps.config;
    if (!tests.runAtCheckpoint || !tests.command || this.exited) return;
    const res = await this.exec(tests.command, tests.timeoutSec);
    this.testsNow = res.exitCode === 0 ? "pass" : "fail";
    this.emit("event", { type: "tests", status: this.testsNow });
  }

  private exec(cmd: string, timeoutSec: number): Promise<{ exitCode: number; stdout: string }> {
    const id = ++this.execSeq;
    return new Promise((resolveExec) => {
      this.pendingExec.set(id, resolveExec);
      this.transport.send({ t: "exec", id, cmd, timeoutSec });
    });
  }

  // ------------------------------------------------------------- finishing

  /**
   * Write the run's closing checkpoint once: capture unsnapshotted changes, then a
   * semantic node unless the agent's own last checkpoint already covers the state.
   */
  private async finalize(reason: "stop" | "interrupt" | "crash"): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    await this.createNode({
      kind: "micro",
      title: "micro: final state",
      summarySource: null,
      status: "progress",
      trigger: reason,
      allowUnchanged: false,
      resumeToolUseId: null,
    }).catch((err) => this.log("warn", `final snapshot failed: ${errorMessage(err)}`));

    const coveredByAgent =
      this.lastSemantic.inThisRun && this.lastSemantic.tree === this.head.tree && reason === "stop";
    if (coveredByAgent) return;
    const status: NodeStatus =
      reason === "stop" ? "done" : reason === "interrupt" ? "killed" : "failed";
    await this.autoCheckpoint(reason, status, null).catch((err) =>
      this.log("error", `final checkpoint failed: ${errorMessage(err)}`),
    );
  }

  private async onExit(code: number, error?: string): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.killTimer);
    for (const resolveExec of this.pendingExec.values()) resolveExec({ exitCode: -1, stdout: "" });
    this.pendingExec.clear();

    const success = !this.interrupted && code === 0 && this.result?.subtype === "success";
    await this.finalize(this.interrupted ? "interrupt" : success ? "stop" : "crash");
    await this.lock;

    const { db } = this.deps;
    const agentStatus: AgentStatus = this.interrupted ? "killed" : success ? "done" : "failed";
    const last = db.getNode(this.lastSemantic.nodeId);
    const reason: EndReason = this.interrupted
      ? "killed"
      : !success
        ? "failed"
        : last?.status === "need_decision" || last?.status === "blocked"
          ? last.status
          : "done";
    const branchStatus: BranchStatus =
      reason === "killed"
        ? "killed"
        : reason === "failed"
          ? "failed"
          : reason === "done"
            ? "done"
            : "idle";
    db.updateAgent(this.agentId, {
      status: agentStatus,
      endedAt: new Date().toISOString(),
      totalCostUsd: this.result?.costUsd ?? null,
      numTurns: this.result?.numTurns ?? null,
      sessionId: this.sessionId,
    });
    db.updateBranch(this.branchId, { status: branchStatus });
    const outcome: RunOutcome = {
      agentId: this.agentId,
      branchId: this.branchId,
      reason,
      headNodeId: this.head.nodeId,
      lastSemanticNodeId: this.lastSemantic.inThisRun ? this.lastSemantic.nodeId : null,
      costUsd: this.result?.costUsd ?? null,
      numTurns: this.result?.numTurns ?? null,
    };
    if (!success && !this.interrupted) outcome.error = error ?? `runner exited with code ${code}`;
    db.appendEvent({
      actorType: "system",
      actorId: null,
      type: "run_end",
      branchId: this.branchId,
      nodeId: this.head.nodeId,
      agentId: this.agentId,
      payload: { ...outcome },
    });
    this.emit("event", { type: "ended", outcome });
    this.resolveDone(outcome);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.emit("event", { type: "log", level, message });
  }
}

// ------------------------------------------------------------------ helpers

function blankNode(
  n: Partial<TurtleNode> &
    Pick<TurtleNode, "id" | "branchId" | "kind" | "commitSha" | "treeSha" | "status">,
): Omit<TurtleNode, "createdAt"> {
  return {
    agentId: null,
    parents: [],
    intent: null,
    summary: null,
    summarySource: null,
    trigger: null,
    sessionId: null,
    resumeToolUseId: null,
    resumeMessageUuid: null,
    tests: null,
    filesChanged: null,
    linesAdded: null,
    linesDeleted: null,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    costUsdEst: 0,
    tags: [],
    explorationGroupId: null,
    ...n,
  };
}

/** Nearest ancestor (or self) that is a semantic or root node. */
function lastSemanticAncestor(db: TurtleDb, node: TurtleNode): TurtleNode {
  let cur: TurtleNode | null = node;
  while (cur) {
    if (cur.kind === "semantic" || cur.kind === "root" || cur.parents.length === 0) return cur;
    const parentId: string | undefined = cur.parents[0];
    cur = parentId ? db.getNode(parentId) : null;
  }
  return node;
}

/** Semantic ancestors of a node (inclusive), newest first. */
export function semanticAncestors(db: TurtleDb, nodeId: string, limit: number): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let cur = db.getNode(nodeId);
  while (cur && out.length < limit) {
    if (cur.kind === "semantic") {
      out.push({ nodeId: cur.id, status: cur.status, summary: cur.summary ?? "" });
    }
    const parentId: string | undefined = cur.parents[0];
    cur = parentId ? db.getNode(parentId) : null;
  }
  return out;
}

function lastSessionOf(db: TurtleDb, branchId: string): string | null {
  const agents = db.listAgents({ branchId });
  for (let i = agents.length - 1; i >= 0; i--) {
    const s = agents[i]?.sessionId;
    if (s) return s;
  }
  return null;
}

async function copyIgnored(
  from: string | null,
  to: string,
  paths: readonly string[],
): Promise<void> {
  if (!from) return;
  for (const p of paths) {
    const src = join(from, p);
    if (await exists(src)) await cp(src, join(to, p), { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: SDK content blocks are untyped JSON.
function contentBlocks(content: unknown): any[] {
  return Array.isArray(content) ? content : [];
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.summary ?? i.description;
  return typeof v === "string" ? truncate(v.replace(/\s+/g, " "), 80) : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { CheckpointStatus };
