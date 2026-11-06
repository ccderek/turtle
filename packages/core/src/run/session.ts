import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
import { AGENT_IDENTITY, BRANCH_REF_PREFIX, type DiffStat, type GitStore } from "../git/store.js";
import { newId } from "../ids.js";
import {
  type CheckpointPart,
  Companion,
  companionBranches,
  resolveCheckpointParts,
  type SourceHandle,
} from "./companion.js";
import {
  checkpointReplyMessage,
  contextPrefix,
  TURTLE_SYSTEM_PROMPT,
  workspaceMovedNote,
} from "./prompt.js";
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
  /**
   * More source repositories for a multi-source run (docs/phase2-spec.md §7.1). The
   * workspace becomes a directory with one subdirectory per source, and every
   * checkpoint snapshots all of them.
   */
  companions?: SourceHandle[];
  /** Subdirectory name of the primary source in a multi-source workspace. */
  primarySourceId?: string;
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
  /** Checkpoint tool calls seen in assistant messages but not yet answered: id → summary. */
  private readonly pendingCheckpointTools = new Map<string, string>();
  /** Agent cwd: the primary workspace, or the directory holding every source's. */
  private root = "";
  private companions: Companion[] = [];
  private primaryId = "main";

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
    const multiWanted = (opts.companions?.length ?? 0) > 0;
    const primaryId = opts.primarySourceId ?? "main";
    let multi = false;
    let rootDir = "";

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
      multi = multiWanted;
      rootDir = join(workspaceRoot, branchId);
      workspace = multi ? join(rootDir, primaryId) : rootDir;
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
      // Rows first, then the ref: a concurrent reconcile must never import this root itself.
      await store.updateRef(ref, root.commit, null);
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
        // A branch keeps the layout it was created with.
        multi = multiWanted && companionBranches(db, fromBranch.id).size > 0;
        rootDir = multi ? dirname(workspace) : workspace;
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
        multi = multiWanted;
        rootDir = join(workspaceRoot, branchId);
        workspace = multi ? join(rootDir, primaryId) : rootDir;
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
          // The resumed conversation may mention the old workspace's absolute paths.
          if (sandbox === "none") promptPrefix = workspaceMovedNote(rootDir);
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
    // A long-lived host (turtle ui) stays alive, so reconcile would never mark this agent
    // dead: record a failure to start right away.
    const companions: Companion[] = [];
    const recordStartFailure = (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      for (const c of companions) c.finish("failed", "failed");
      db.transaction(() => {
        db.updateAgent(agentId, { status: "failed", endedAt: new Date().toISOString() });
        db.updateBranch(branch.id, { status: "failed" });
        db.appendEvent({
          actorType: "system",
          actorId: null,
          type: "run_end",
          branchId: branch.id,
          nodeId: headNode.id,
          agentId,
          payload: { agentId, branchId: branch.id, reason: "failed", error },
        });
      });
    };
    if (multi) {
      try {
        const known =
          mode === "continue" ? companionBranches(db, branch.id) : new Map<string, string>();
        const parts =
          mode === "fork"
            ? resolveCheckpointParts(db, headNode.id)
            : new Map<string, CheckpointPart>();
        for (const src of opts.companions ?? []) {
          const c = await Companion.start(src, {
            root: rootDir,
            agentId,
            prompt: opts.prompt,
            sandbox,
            fromHead: opts.fromHead ?? false,
            continueBranchId: known.get(src.id) ?? null,
            fromNodeId: parts.get(src.id)?.nodeId ?? null,
            checkpointId: headNode.id,
          });
          companions.push(c);
          if (mode !== "continue")
            await copyIgnored(src.store.topLevel, c.workTree, config.workspace.copyIgnored);
        }
      } catch (err) {
        recordStartFailure(err);
        throw err;
      }
    }

    db.appendEvent({
      actorType: "human",
      actorId: null,
      type: mode === "fork" ? "fork" : "run_start",
      branchId: branch.id,
      nodeId: headNode.id,
      agentId,
      payload: {
        mode,
        prompt: opts.prompt,
        resumed: Boolean(resume.resume),
        maxBudgetUsd: opts.maxBudgetUsd ?? config.agent.maxBudgetUsd ?? null,
        ...(multi
          ? {
              primarySource: primaryId,
              companions: companions.map((c) => ({ source: c.id, branchId: c.branch.id })),
              parts: companions.map((c) => c.headPart),
            }
          : {}),
      },
    });

    const session = new RunSession(deps, opts, mode, branch, agentId, workspace);
    session.root = rootDir;
    session.companions = companions;
    session.primaryId = primaryId;
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

    let transport: RunnerTransport;
    try {
      transport = await deps.launcher({
        agentId,
        branchId: branch.id,
        workspace: rootDir,
        sandbox,
        claudeConfigDir: join(store.turtleDir, "claude"),
        logFile: join(store.turtleDir, "logs", `${agentId}.log`),
        env: {},
      });
    } catch (err) {
      recordStartFailure(err);
      throw err;
    }
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
    if (!isPersistedMessage(m)) return;
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
          if (block.name === "mcp__turtle__checkpoint") {
            this.pendingCheckpointTools.set(block.id, String(block.input?.summary ?? ""));
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
      req.failed ?? false,
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
      const stat = addStats(
        await this.deps.store.diffStat(this.lastSemantic.tree, this.head.tree),
        ...(await Promise.all(this.companions.map((c) => c.statSinceCheckpoint()))),
      );
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
    const toolUseId = req.toolUseId ?? this.matchCheckpointTool(req.summary);
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
      resumeToolUseId: toolUseId,
    });
    if (!node) throw new Error("checkpoint was not recorded");
    for (const a of req.artifacts ?? []) {
      const abs = resolve(this.root, a.path);
      if (abs !== this.root && !abs.startsWith(this.root + sep)) {
        this.log("warn", `artifact outside workspace ignored: ${a.path}`);
        continue;
      }
      try {
        const info = await fsStat(abs);
        const blobSha = await store.hashFile(abs);
        db.insertArtifact({
          nodeId: node.id,
          label: a.label ?? null,
          path: relative(this.root, abs),
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

  /**
   * The MCP tool handler does not learn its tool_use id, so match the request to the
   * newest unanswered checkpoint tool call with the same summary.
   */
  private matchCheckpointTool(summary: string): string | null {
    const ids = [...this.pendingCheckpointTools.keys()].reverse();
    const id = ids.find((k) => this.pendingCheckpointTools.get(k) === summary) ?? ids[0] ?? null;
    if (id) this.pendingCheckpointTools.delete(id);
    return id;
  }

  private async onDiff(since: string | undefined, path: string | undefined): Promise<DiffReply> {
    const { db, store } = this.deps;
    let fromTree: string;
    let fromParts: Map<string, CheckpointPart> | null = null;
    if (!since || since === "branch_start") {
      fromTree = db.getNode(this.branch.rootNodeId)?.treeSha ?? (await store.emptyTree());
    } else if (since === "last_checkpoint") {
      fromTree = this.lastSemantic.tree;
    } else {
      const n = db.getNode(since) ?? db.findNodesByPrefix(since, 2).at(0);
      if (!n) throw new Error(`unknown node ${since}`);
      fromTree = n.treeSha;
      if (this.companions.length) fromParts = resolveCheckpointParts(db, n.id);
    }
    const prefixOf = (id: string) => (this.companions.length ? { prefix: id } : {});
    // In a multi-source workspace, paths start with the source's directory.
    const pathFor = (id: string): string[] => {
      if (!path) return [];
      if (!this.companions.length) return [path];
      return path === id || path.startsWith(`${id}/`) ? [path.slice(id.length + 1) || "."] : [];
    };
    const wanted = (id: string) =>
      !path || !this.companions.length || path === id || path.startsWith(`${id}/`);
    let diff = wanted(this.primaryId)
      ? await store.diff(
          fromTree,
          this.head.tree,
          pathFor(this.primaryId),
          prefixOf(this.primaryId),
        )
      : "";
    for (const c of this.companions) {
      if (!wanted(c.id)) continue;
      const from =
        !since || since === "branch_start"
          ? c.rootTree
          : since === "last_checkpoint"
            ? c.checkpointTree
            : (fromParts?.get(c.id)?.tree ?? c.rootTree);
      diff += await c.source.store.diff(from, c.headTree, pathFor(c.id), prefixOf(c.id));
    }
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
      // Companions first: a change in any source makes this a checkpoint.
      const parts: { part: CheckpointPart; stat: DiffStat }[] = [];
      for (const c of this.companions) {
        const r = await c.snapshot({
          checkpointId: id,
          kind: p.kind,
          title: p.title,
          ...(p.body ? { body: p.body } : {}),
          status: p.status,
          trigger: p.trigger,
          allowUnchanged: p.allowUnchanged,
        });
        if (r) parts.push(r);
      }
      const res = await store.snapshot({
        workTree: this.workspace,
        indexFile: store.indexFileFor(this.branchId),
        parent: { commit: this.head.commit, tree: this.head.tree },
        message: p.body ? { title: p.title, body: p.body, trailers } : { title: p.title, trailers },
        identity: AGENT_IDENTITY,
        allowUnchanged: p.allowUnchanged || parts.length > 0,
        ref: { name: this.branch.ref, expectedOld: this.head.commit },
      });
      if (!res) return null;
      const { tokens, costUsd } = this.usage.drain();
      // Semantic nodes report changes since the previous checkpoint, micro nodes since their parent.
      const own =
        p.kind === "semantic" ? await store.diffStat(this.lastSemantic.tree, res.tree) : res.stat;
      const stat = addStats(own, ...parts.map((x) => x.stat));
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
            filesChanged: stat.filesChanged,
            linesAdded: stat.linesAdded,
            linesDeleted: stat.linesDeleted,
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
            ...(parts.length ? { parts: parts.map((x) => x.part) } : {}),
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
    const sides = [
      {
        store,
        from: this.lastSemantic.tree,
        to: this.head.tree,
        prefix: this.companions.length ? this.primaryId : "",
      },
      ...this.companions.map((c) => ({
        store: c.source.store,
        from: c.checkpointTree,
        to: c.headTree,
        prefix: c.id,
      })),
    ];
    const per = await Promise.all(
      sides.map(async (x) => {
        const [stat, diff, names] = await Promise.all([
          x.store.diffStat(x.from, x.to),
          x.store.diff(x.from, x.to, [], x.prefix ? { prefix: x.prefix } : {}),
          x.from === x.to
            ? Promise.resolve("")
            : x.store.run(["diff-tree", "-r", "--name-only", "--no-renames", x.from, x.to]),
        ]);
        const paths = names
          ? names.split("\n").map((n) => (x.prefix ? `${x.prefix}/${n}` : n))
          : [];
        return { stat, diff, paths };
      }),
    );
    const diff = per.map((x) => x.diff).join("");
    return {
      intent: this.opts.prompt,
      trigger,
      stat: addStats(...per.map((x) => x.stat)),
      changedPaths: per.flatMap((x) => x.paths),
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
    for (const c of this.companions) c.finish(branchStatus, agentStatus);
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

/**
 * Only conversation messages are stored; streaming deltas, status and rate-limit
 * notices are ephemeral and would bloat the DB.
 */
function isPersistedMessage(m: SdkMessage): boolean {
  if (m.type === "assistant" || m.type === "user" || m.type === "result") return true;
  return m.type === "system" && (m.subtype === "init" || m.subtype === "compact_boundary");
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

function addStats(...stats: DiffStat[]): DiffStat {
  return stats.reduce(
    (a, b) => ({
      filesChanged: a.filesChanged + b.filesChanged,
      linesAdded: a.linesAdded + b.linesAdded,
      linesDeleted: a.linesDeleted + b.linesDeleted,
    }),
    { filesChanged: 0, linesAdded: 0, linesDeleted: 0 },
  );
}
