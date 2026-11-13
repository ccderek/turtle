import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  createSdkMcpServer as SdkCreateServer,
  query as SdkQuery,
  tool as SdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CheckpointReply,
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
import { z } from "zod";

export const ADAPTER_ID = "claude-agent-sdk";
export const RUNNER_VERSION = "0.1.0";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerDeps {
  send(msg: FromRunner): void;
  /** Called once when the runner is done; the process should exit with `code`. */
  exit(code: number): void;
  cwd: string;
  sdk: { query: typeof SdkQuery; tool: typeof SdkTool; createSdkMcpServer: typeof SdkCreateServer };
  exec?: (cmd: string, cwd: string, timeoutSec: number) => Promise<ExecResult>;
  /** Claude config dir holding session transcripts (default: CLAUDE_CONFIG_DIR or ~/.claude). */
  claudeConfigDir?: string;
}

/**
 * Runs one Claude Agent SDK query on behalf of the turtle orchestrator
 * (docs/phase0-spec.md §9): forwards every SDK message, reports tool calls through
 * hooks (blocking until the orchestrator has snapshotted), and exposes the turtle
 * MCP tools (checkpoint, diff, history).
 */
export class ClaudeRunner {
  private graphTools = false;
  private reqSeq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private q: Query | null = null;
  private closeInput: () => void = () => {};
  /** Human messages waiting to be yielded into the SDK's streaming input. */
  private readonly inbox: string[] = [];
  private wakeInput: () => void = () => {};
  /** A human message went into the SDK after the model's last output. */
  private messageSinceOutput = false;
  private closeTimer: NodeJS.Timeout | undefined;
  private started = false;
  private finished = false;
  private interrupted = false;

  constructor(private readonly deps: RunnerDeps) {}

  /** Announce the runner; call once the transport is wired. */
  ready(): void {
    this.deps.send({
      t: "ready",
      adapter: ADAPTER_ID,
      level: 2,
      capabilities: ["resume", "fork", "interrupt", "checkpoint_tool", "exec"],
      version: RUNNER_VERSION,
    });
  }

  handle(msg: ToRunner): void {
    switch (msg.t) {
      case "start":
        if (this.started) return;
        this.started = true;
        void this.run(msg.prompt, msg.options);
        return;
      case "reply": {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.result);
        else p?.reject(new Error(msg.error));
        return;
      }
      case "exec":
        void this.exec(msg.cmd, msg.timeoutSec).then((r) =>
          this.deps.send({ t: "exec_result", id: msg.id, ...r }),
        );
        return;
      case "interrupt":
        void this.interrupt();
        return;
      case "user":
        this.inbox.push(msg.text);
        this.wakeInput();
        return;
      case "shutdown":
        this.closeInput();
        this.q?.close();
        this.finish(0);
        return;
    }
  }

  private request<T>(req: DistributiveOmit<RunnerRequest, "t" | "id">): Promise<T> {
    const id = ++this.reqSeq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.deps.send({ t: "request", id, ...req } as RunnerRequest);
    });
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.send({ t: "log", level, message });
  }

  private exec(cmd: string, timeoutSec: number): Promise<ExecResult> {
    return (this.deps.exec ?? defaultExec)(cmd, this.deps.cwd, timeoutSec);
  }

  private async interrupt(): Promise<void> {
    this.interrupted = true;
    if (!this.q) {
      this.finish(130);
      return;
    }
    try {
      await this.q.interrupt();
    } catch (err) {
      this.log("warn", `interrupt failed, closing query: ${errorMessage(err)}`);
      this.q.close();
    }
    this.closeInput();
  }

  private finish(code: number, error?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.send(error ? { t: "exit", code, error } : { t: "exit", code });
    this.deps.exit(code);
  }

  // -------------------------------------------------------------------- run

  private async run(prompt: string, o: RunnerStartOptions): Promise<void> {
    try {
      if (o.setupCommand) {
        this.log("info", `setup: ${o.setupCommand}`);
        const res = await this.exec(o.setupCommand, 1800);
        if (res.exitCode !== 0) {
          this.finish(1, `setup command failed (exit ${res.exitCode}): ${res.stderr.slice(-2000)}`);
          return;
        }
      }
      if (o.resume) {
        const configDir =
          this.deps.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
        const copied = await ensureSessionInProject(configDir, o.resume, this.deps.cwd);
        if (copied)
          this.log("info", `copied session ${o.resume} into this workspace's project dir`);
      }
      const inputDone = new Promise<void>((resolve) => {
        this.closeInput = resolve;
      });
      this.q = this.deps.sdk.query({
        prompt: this.userInput(prompt, inputDone),
        options: this.options(o),
      });
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        this.deps.send({ t: "sdk", msg });
        if (msg.type === "assistant") this.messageSinceOutput = false;
        if (msg.type !== "result") {
          clearTimeout(this.closeTimer);
          continue;
        }
        // Close the input after a result so the query ends, unless a human message is
        // waiting or just went in as the turn ended: then give the next turn a moment
        // to start (any new output cancels the close).
        if (this.inbox.length) continue;
        if (this.messageSinceOutput) {
          clearTimeout(this.closeTimer);
          this.closeTimer = setTimeout(() => this.closeInput(), 3000);
        } else this.closeInput();
      }
      this.finish(this.interrupted ? 130 : 0);
    } catch (err) {
      this.finish(this.interrupted ? 130 : 1, errorMessage(err));
    }
  }

  /** Build SDK options (exported shape is checked in tests). */
  options(o: RunnerStartOptions): Options {
    this.graphTools = o.graphTools ?? false;
    const options: Options = {
      cwd: this.deps.cwd,
      systemPrompt: { type: "preset", preset: "claude_code", append: o.systemPromptAppend },
      permissionMode: o.permissionMode,
      mcpServers: { turtle: this.mcpServer() },
      hooks: {
        PostToolUse: [{ hooks: [this.postToolUseHook] }],
        PostToolUseFailure: [{ hooks: [this.postToolUseHook] }],
        Stop: [{ hooks: [this.stopHook] }],
      },
      env: sanitizeEnv(process.env),
    };
    if (o.permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (o.allowedTools) options.allowedTools = o.allowedTools;
    if (o.model) options.model = o.model;
    if (o.effort) options.effort = o.effort;
    if (o.maxTurns) options.maxTurns = o.maxTurns;
    if (o.maxBudgetUsd) options.maxBudgetUsd = o.maxBudgetUsd;
    if (o.resume) options.resume = o.resume;
    if (o.resumeSessionAt) options.resumeSessionAt = o.resumeSessionAt;
    if (o.forkSession) options.forkSession = true;
    return options;
  }

  private readonly postToolUseHook: HookCallback = async (input) => {
    let reply: HookReply | undefined;
    if (input.hook_event_name === "PostToolUse") {
      reply = await this.request<HookReply>({
        kind: "post_tool_use",
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
        toolResponse: input.tool_response,
        ...(input.agent_id ? { agentId: input.agent_id } : {}),
      });
    } else if (input.hook_event_name === "PostToolUseFailure") {
      if (input.is_interrupt) return {};
      reply = await this.request<HookReply>({
        kind: "post_tool_use",
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
        toolResponse: input.error,
        failed: true,
        ...(input.agent_id ? { agentId: input.agent_id } : {}),
      });
    }
    void reply;
    return {};
  };

  private readonly stopHook: HookCallback = async (input) => {
    if (input.hook_event_name === "Stop") {
      await this.request<HookReply>({
        kind: "stop",
        lastAssistantMessage: input.last_assistant_message ?? "",
      });
    }
    return {};
  };

  /**
   * Streaming input: the prompt, then human messages as they arrive (genuine user turns,
   * docs/phase2-spec.md §11), until `done` (also needed for interrupt()).
   */
  private async *userInput(prompt: string, done: Promise<void>): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    let finished = false;
    void done.then(() => {
      finished = true;
      this.wakeInput();
    });
    for (;;) {
      while (this.inbox.length) {
        const text = this.inbox.shift() as string;
        this.messageSinceOutput = true;
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      }
      if (finished) return;
      await new Promise<void>((r) => {
        this.wakeInput = r;
      });
    }
  }

  /** Task-graph tools (docs/phase2-spec.md §8); each forwards one `graph` request. */
  private graphToolDefs(
    tool: typeof SdkTool,
    text: (t: string) => { content: { type: "text"; text: string }[] },
  ) {
    const call = async (op: GraphOp, args: Record<string, unknown>) => {
      const reply = await this.request<GraphReply>({ kind: "graph", op, args });
      return text(reply.message);
    };
    const evidence = z
      .array(
        z.object({
          path: z
            .string()
            .optional()
            .describe(
              "A file you wrote (e.g. results/run1.csv), relative to the working directory.",
            ),
          checkpoint: z.string().optional().describe("A checkpoint id."),
        }),
      )
      .optional();
    return [
      tool(
        "task",
        "Create a subtask under your task (op create), or update one of your tasks (op update). Split work only when parts can run independently or need a different starting point.",
        {
          op: z.enum(["create", "update"]),
          id: z.string().optional().describe("Task id (update)."),
          title: z.string().optional(),
          body: z.string().optional().describe("What the task must do and how to know it is done."),
          dependsOn: z
            .array(z.string())
            .optional()
            .describe("Ids of tasks that must be done first."),
          startFrom: z
            .string()
            .optional()
            .describe('"here" to start from your latest checkpoint, or a checkpoint id.'),
          status: z.enum(["done", "blocked"]).optional().describe("Update only."),
        },
        async (args) => call("task", args),
      ),
      tool(
        "finding",
        "Record something you learned (a measurement, a cause, a fact). Attach evidence: a file with the data, or a checkpoint.",
        { text: z.string(), evidence },
        async (args) => call("finding", args),
      ),
      tool(
        "decision",
        "Record a choice you made and why, so the human sees pivots.",
        { text: z.string(), rationale: z.string().optional() },
        async (args) => call("decision", args),
      ),
      tool(
        "question",
        "Ask the human something only they can decide. Your task waits for the answer; end your turn after asking.",
        { text: z.string(), options: z.array(z.string()).optional() },
        async (args) => call("question", args),
      ),
      tool(
        "brief",
        "Replace your task's brief: status first, then conclusions with their evidence, then open questions. Keep it current at each checkpoint.",
        { text: z.string() },
        async (args) => call("brief", args),
      ),
      tool(
        "lesson",
        "Propose a lesson for work that comes after yours (what not to repeat, and why). A human confirms it.",
        { text: z.string(), evidence },
        async (args) => call("lesson", args),
      ),
      tool(
        "check",
        "Propose a check: a script that tests the work in the working directory and exits 0 when it is acceptable (e.g. that a lesson holds). It runs at every checkpoint under its scope once a human activates it; you cannot change it afterwards.",
        {
          title: z.string().describe("What the check verifies, in one line."),
          file: z.string().describe("File name: .py (python3), .sh (bash), .js or .mjs (node)."),
          script: z
            .string()
            .describe(
              "The script. It runs with the working directory as cwd; exit 0 passes, and its output explains a failure.",
            ),
          lesson: z.string().optional().describe("A lesson id this check enforces."),
        },
        async (args) => call("check", args),
      ),
      tool(
        "recipe",
        "Record how to redo your task's step: a script that regenerates its output files from the files in your working directory, with parameters as environment variables (e.g. MODEL=A). When your run ends, turtle verifies it by replaying it from a clean copy of your latest checkpoint; a verified recipe lets the step be replayed with other parameters without a model.",
        {
          title: z.string().describe("What the recipe redoes, in one line."),
          file: z.string().describe("File name: .py (python3), .sh (bash), .js or .mjs (node)."),
          script: z
            .string()
            .describe(
              "The script. It runs with the working directory as cwd and may call scripts you checkpointed. Exit 0 on success.",
            ),
          params: z
            .record(z.string(), z.string())
            .optional()
            .describe('Parameters and their defaults, e.g. {"MODEL": "A"}.'),
          outputs: z.array(z.string()).optional().describe(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a pattern turtle expands, shown to the model.
            "Files it regenerates (may use ${MODEL}); they are compared when verifying.",
          ),
          tolerance: z
            .number()
            .optional()
            .describe("Relative tolerance for numbers in CSV outputs, e.g. 0.03 for measurements."),
        },
        async (args) => call("recipe", args),
      ),
      tool(
        "graph",
        "Show the task graph around your task: your task, siblings, what you depend on, decisions and the lessons you must follow.",
        { scope: z.enum(["task", "goal"]).optional() },
        async (args) => call("read", args),
      ),
    ];
  }

  private mcpServer() {
    const { tool, createSdkMcpServer } = this.deps.sdk;
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    return createSdkMcpServer({
      name: "turtle",
      version: RUNNER_VERSION,
      alwaysLoad: true,
      tools: [
        tool(
          "checkpoint",
          "Record a meaningful checkpoint of your work (like a commit). Call it when you finish a sub-goal, before changing approach, or when you need a human decision. Files are snapshotted automatically after edits; do not call this after every edit.",
          {
            summary: z
              .string()
              .describe(
                "Commit-message style: first line under 72 characters, then what changed and why.",
              ),
            status: z
              .enum(["progress", "done", "blocked", "need_decision"])
              .describe(
                '"need_decision"/"blocked" only when you cannot continue without the human.',
              ),
            artifacts: z
              .array(z.object({ path: z.string(), label: z.string().optional() }))
              .optional()
              .describe(
                "Files in the working directory worth keeping with this checkpoint (logs, screenshots).",
              ),
          },
          async (args) => {
            const reply = await this.request<CheckpointReply>({
              kind: "checkpoint",
              summary: args.summary,
              status: args.status,
              ...(args.artifacts
                ? {
                    artifacts: args.artifacts.map((a) =>
                      a.label ? { path: a.path, label: a.label } : { path: a.path },
                    ),
                  }
                : {}),
            });
            return text(reply.message);
          },
        ),
        tool(
          "diff",
          "Show a unified diff of your work. There is no .git in the working directory; use this instead of git diff.",
          {
            since: z
              .string()
              .optional()
              .describe('"branch_start" (default), "last_checkpoint", or a checkpoint id.'),
            path: z.string().optional().describe("Limit the diff to this path."),
          },
          async (args) => {
            const reply = await this.request<DiffReply>({
              kind: "diff",
              ...(args.since ? { since: args.since } : {}),
              ...(args.path ? { path: args.path } : {}),
            });
            return text(reply.diff || "(no changes)");
          },
        ),
        ...(this.graphTools ? this.graphToolDefs(tool, text) : []),
        tool(
          "history",
          "List earlier checkpoints on this branch, newest first. Use this instead of git log.",
          { limit: z.number().int().positive().max(100).optional() },
          async (args) => {
            const entries = await this.request<HistoryEntry[]>({
              kind: "history",
              ...(args.limit ? { limit: args.limit } : {}),
            });
            if (entries.length === 0) return text("(no checkpoints yet)");
            return text(
              entries.map((e) => `${e.nodeId.slice(0, 6)} [${e.status}] ${e.summary}`).join("\n\n"),
            );
          },
        ),
      ],
    });
  }
}

export function defaultExec(cmd: string, cwd: string, timeoutSec: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = (s: string, d: Buffer) => (s + d.toString("utf8")).slice(-100_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout = cap(stdout, d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = cap(stderr, d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

/**
 * Variables that tie a process to an enclosing Claude Code session (when turtle itself is
 * run from inside Claude Code). Passing them on would make the agent join or report to
 * that session, so they are removed. Credentials and provider settings are kept.
 */
const HOST_SESSION_VARS = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_AFTER_LAST_COMPACT$/,
  /^CLAUDE_CODE_(REMOTE_)?SESSION_ID$/,
  /^CLAUDE_CODE_SESSION_ATTENDED$/,
  /^CLAUDE_CODE_CHILD_SESSION$/,
  /^CLAUDE_CODE_REMOTE_SDK_URL$/,
  /^CLAUDE_CODE_MESSAGING_(SOCKET|TOKEN)$/,
  /^CLAUDE_SESSION_INGRESS_TOKEN_FILE$/,
  /^CLAUDE_CODE_POST_FOR_SESSION_INGRESS/,
  /^CLAUDE_CODE_TEE_SDK_STDOUT$/,
  /^CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES$/,
  /^CLAUDE_CODE_DIAGNOSTICS_FILE$/,
  /^CLAUDE_CODE_WORKER_EPOCH$/,
  /^CLAUDE_CODE_SYNC_SESSION_REFS$/,
  /^CLAUDE_CODE_ENTRYPOINT$/,
];

export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!HOST_SESSION_VARS.some((re) => re.test(k))) out[k] = v;
  }
  return out;
}

/** Claude Code's project directory name for a working directory (VERIFY: naming scheme). */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Sessions are stored per working directory, so a session started in another workspace
 * is not found when resuming here (docs/phase0-spec.md §10). Copy its transcript into
 * this workspace's project directory. Returns true when a copy was made.
 */
export async function ensureSessionInProject(
  configDir: string,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  const projects = join(configDir, "projects");
  const target = join(projects, projectDirName(cwd), `${sessionId}.jsonl`);
  if (await exists(target)) return false;
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return false;
  }
  for (const d of dirs) {
    const source = join(projects, d, `${sessionId}.jsonl`);
    if (await exists(source)) {
      await mkdir(join(projects, projectDirName(cwd)), { recursive: true });
      await copyFile(source, target);
      return true;
    }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
