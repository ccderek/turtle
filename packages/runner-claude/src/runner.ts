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
  HistoryEntry,
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
  private reqSeq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private q: Query | null = null;
  private closeInput: () => void = () => {};
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
        prompt: userInput(prompt, inputDone),
        options: this.options(o),
      });
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        this.deps.send({ t: "sdk", msg });
        // One turn per run: close the input after the first result so the query ends.
        if (msg.type === "result") this.closeInput();
      }
      this.finish(this.interrupted ? 130 : 0);
    } catch (err) {
      this.finish(this.interrupted ? 130 : 1, errorMessage(err));
    }
  }

  /** Build SDK options (exported shape is checked in tests). */
  options(o: RunnerStartOptions): Options {
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
    if (o.maxTurns) options.maxTurns = o.maxTurns;
    if (o.maxBudgetUsd) options.maxBudgetUsd = o.maxBudgetUsd;
    if (o.resume) options.resume = o.resume;
    if (o.resumeSessionAt) options.resumeSessionAt = o.resumeSessionAt;
    if (o.forkSession) options.forkSession = true;
    return options;
  }

  private readonly postToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      await this.request({
        kind: "post_tool_use",
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
        toolResponse: input.tool_response,
        ...(input.agent_id ? { agentId: input.agent_id } : {}),
      });
    } else if (input.hook_event_name === "PostToolUseFailure") {
      if (input.is_interrupt) return {};
      await this.request({
        kind: "post_tool_use",
        toolName: input.tool_name,
        toolUseId: input.tool_use_id,
        toolInput: input.tool_input,
        toolResponse: input.error,
        failed: true,
        ...(input.agent_id ? { agentId: input.agent_id } : {}),
      });
    }
    return {};
  };

  private readonly stopHook: HookCallback = async (input) => {
    if (input.hook_event_name === "Stop") {
      await this.request({
        kind: "stop",
        lastAssistantMessage: input.last_assistant_message ?? "",
      });
    }
    return {};
  };

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

/** Streaming input: the prompt, then stay open until `done` (needed for interrupt()). */
async function* userInput(prompt: string, done: Promise<void>): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
  await done;
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
