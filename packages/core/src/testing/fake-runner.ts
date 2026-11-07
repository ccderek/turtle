import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ArtifactRef,
  CheckpointReply,
  CheckpointStatus,
  DiffReply,
  FromRunner,
  GraphOp,
  GraphReply,
  HistoryEntry,
  HookReply,
  RunnerRequest,
  RunnerStartOptions,
  ToRunner,
} from "@turtle/protocol";
import {
  createTransportPair,
  type LaunchSpec,
  type RunnerLauncher,
  type RunnerSide,
} from "../run/transport.js";

export class FakeInterrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "FakeInterrupted";
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A scripted agent that speaks the runner protocol exactly like runner-claude, so the
 * orchestrator can be tested (and demoed) without an API key. Messages mimic the
 * Claude Agent SDK shapes the orchestrator reads.
 */
export class FakeAgent {
  readonly sessionId: string;
  interrupted = false;
  /** Instructions delivered by the orchestrator at tool boundaries or on stop. */
  readonly instructions: string[] = [];
  private reqSeq = 0;
  private msgSeq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private interruptWaiters: (() => void)[] = [];

  constructor(
    private readonly side: RunnerSide,
    readonly spec: LaunchSpec,
    readonly prompt: string,
    readonly options: RunnerStartOptions,
    readonly model = "claude-opus-5-5",
  ) {
    this.sessionId = options.resume && !options.forkSession ? options.resume : randomUUID();
  }

  get workspace(): string {
    return this.spec.workspace;
  }

  /** @internal */
  handle(msg: ToRunner, execHandler: (cmd: string) => number): void {
    if (msg.t === "reply") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.result);
      else p?.reject(new Error(msg.error));
    } else if (msg.t === "user") {
      this.instructions.push(msg.text);
    } else if (msg.t === "interrupt") {
      this.interrupted = true;
      for (const w of this.interruptWaiters) w();
      this.interruptWaiters = [];
    } else if (msg.t === "exec") {
      this.side.send({
        t: "exec_result",
        id: msg.id,
        exitCode: execHandler(msg.cmd),
        stdout: "",
        stderr: "",
      });
    }
  }

  send(msg: FromRunner): void {
    this.side.send(msg);
  }

  request<T>(req: DistributiveOmit<RunnerRequest, "t" | "id">): Promise<T> {
    const id = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.side.send({ t: "request", id, ...req } as RunnerRequest);
    });
  }

  sdk(msg: Record<string, unknown>): string {
    const uuid = randomUUID();
    this.side.send({
      t: "sdk",
      msg: { uuid, session_id: this.sessionId, parent_tool_use_id: null, ...msg },
    });
    return uuid;
  }

  private check(): void {
    if (this.interrupted) throw new FakeInterrupted();
  }

  private assistant(content: unknown[], usage = { input_tokens: 100, output_tokens: 20 }): string {
    return this.sdk({
      type: "assistant",
      message: { id: `msg_${++this.msgSeq}`, role: "assistant", model: this.model, content, usage },
    });
  }

  init(): void {
    this.sdk({
      type: "system",
      subtype: "init",
      model: this.model,
      cwd: this.workspace,
      tools: [],
    });
  }

  async say(text: string): Promise<void> {
    this.check();
    this.assistant([{ type: "text", text }]);
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const path = join(this.workspace, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async deleteFile(rel: string): Promise<void> {
    await rm(join(this.workspace, rel), { force: true });
  }

  /**
   * One tool call: assistant tool_use → effect → PostToolUse hook (waits for the
   * orchestrator) → user tool_result. Returns the tool_use id.
   */
  async tool(
    name: string,
    input: Record<string, unknown>,
    opts: {
      effect?: () => Promise<void>;
      response?: unknown;
      agentId?: string;
      failed?: boolean;
    } = {},
  ): Promise<string> {
    this.check();
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    this.assistant([{ type: "tool_use", id: toolUseId, name, input }]);
    await opts.effect?.();
    const req: DistributiveOmit<RunnerRequest, "t" | "id"> = {
      kind: "post_tool_use",
      toolName: name,
      toolUseId,
      toolInput: input,
      toolResponse: opts.response ?? "ok",
    };
    if (opts.agentId) (req as { agentId?: string }).agentId = opts.agentId;
    if (opts.failed) (req as { failed?: boolean }).failed = true;
    await this.request<HookReply>(req);
    this.sdk({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
      },
    });
    return toolUseId;
  }

  /** Write a file through an Edit tool call. */
  edit(rel: string, content: string): Promise<string> {
    return this.tool("Edit", { file_path: rel }, { effect: () => this.writeFile(rel, content) });
  }

  /** Declare a checkpoint through mcp__turtle__checkpoint, as the model would. */
  async checkpoint(
    summary: string,
    status: CheckpointStatus = "progress",
    artifacts?: ArtifactRef[],
  ): Promise<CheckpointReply> {
    this.check();
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = artifacts ? { summary, status, artifacts } : { summary, status };
    this.assistant([{ type: "tool_use", id: toolUseId, name: "mcp__turtle__checkpoint", input }]);
    // Like runner-claude, the request does not carry the tool_use id; the orchestrator matches it.
    const reply = await this.request<CheckpointReply>({ kind: "checkpoint", ...input });
    await this.requestNoting({
      kind: "post_tool_use",
      toolName: "mcp__turtle__checkpoint",
      toolUseId,
      toolInput: input,
      toolResponse: reply.message,
    });
    this.sdk({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: reply.message }],
      },
    });
    return reply;
  }

  /** Call a task-graph tool (mcp__turtle__<op>) the way the model would. */
  async graph(op: GraphOp, args: Record<string, unknown> = {}): Promise<GraphReply> {
    this.check();
    const name = op === "read" ? "graph" : op;
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`;
    this.assistant([
      { type: "tool_use", id: toolUseId, name: `mcp__turtle__${name}`, input: args },
    ]);
    const reply = await this.request<GraphReply>({ kind: "graph", op, args });
    await this.requestNoting({
      kind: "post_tool_use",
      toolName: `mcp__turtle__${name}`,
      toolUseId,
      toolInput: args,
      toolResponse: reply.message,
    });
    this.sdk({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: reply.message }],
      },
    });
    return reply;
  }

  diff(since?: string): Promise<DiffReply> {
    return this.request<DiffReply>(since ? { kind: "diff", since } : { kind: "diff" });
  }

  history(): Promise<HistoryEntry[]> {
    return this.request<HistoryEntry[]>({ kind: "history" });
  }

  /** Resolves when the orchestrator sends interrupt. */
  waitForInterrupt(): Promise<void> {
    if (this.interrupted) return Promise.resolve();
    return new Promise((r) => this.interruptWaiters.push(r));
  }

  /**
   * End the turn: Stop hook, result message, exit. If the orchestrator answers the Stop
   * hook with an instruction, the conversation goes on: no result is sent and the
   * instruction is returned, so the script can act on it and call finish() again.
   */
  async finish(text?: string): Promise<string | undefined> {
    if (text) await this.say(text);
    const before = this.instructions.length;
    await this.request<HookReply>({ kind: "stop", lastAssistantMessage: text ?? "" });
    // A message that arrived with the stop starts one more turn.
    if (this.instructions.length > before) return this.instructions.at(-1);
    this.result("success");
    return undefined;
  }

  private async requestNoting(req: DistributiveOmit<RunnerRequest, "t" | "id">): Promise<void> {
    await this.request<HookReply>(req);
  }

  result(subtype: string): void {
    this.sdk({
      type: "result",
      subtype,
      is_error: subtype !== "success",
      num_turns: this.msgSeq,
      total_cost_usd: this.msgSeq * 0.01,
      usage: {},
      modelUsage: {},
    });
  }
}

export type FakeScript = (agent: FakeAgent) => Promise<unknown>;

export interface FakeLauncherOptions {
  /** Exit code returned for `exec` commands (tests / setup). */
  exec?: (cmd: string) => number;
  /** Called with every agent the launcher creates. */
  onAgent?: (agent: FakeAgent) => void;
  /** Exit without sending `exit` (simulates a crash). */
  crash?: boolean;
}

/** A RunnerLauncher whose runner executes `script` in-process. */
export function fakeLauncher(script: FakeScript, opts: FakeLauncherOptions = {}): RunnerLauncher {
  return async (spec) => {
    const { orchestrator, runner } = createTransportPair();
    let agent: FakeAgent | null = null;
    const execHandler = opts.exec ?? (() => 0);
    runner.onMessage((msg) => {
      if (msg.t === "start") {
        agent = new FakeAgent(runner, spec, msg.prompt, msg.options);
        opts.onAgent?.(agent);
        void run(agent);
      } else {
        agent?.handle(msg, execHandler);
      }
    });
    const run = async (a: FakeAgent) => {
      a.init();
      try {
        await script(a);
        if (opts.crash) {
          runner.close(137);
          return;
        }
        runner.send({ t: "exit", code: 0 });
      } catch (err) {
        if (err instanceof FakeInterrupted) {
          a.result("error_during_execution");
          runner.send({ t: "exit", code: 130 });
        } else {
          runner.send({
            t: "exit",
            code: 1,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      runner.close(0);
    };
    setImmediate(() =>
      runner.send({
        t: "ready",
        adapter: "fake",
        level: 2,
        capabilities: ["resume", "fork", "interrupt"],
        version: "0",
      }),
    );
    return orchestrator;
  };
}
