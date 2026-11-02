import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLineParser, encodeMessage, type FromRunner, type ToRunner } from "@turtle/protocol";
import type { SandboxMode } from "../db/types.js";

/** The orchestrator's view of a running runner. */
export interface RunnerTransport {
  send(msg: ToRunner): void;
  onMessage(cb: (msg: FromRunner) => void): void;
  /** Called once when the runner process (or fake) is gone. */
  onClose(cb: (code: number | null) => void): void;
  /** Forcefully stop the runner. */
  kill(): void;
  readonly pid?: number;
}

export interface LaunchSpec {
  agentId: string;
  branchId: string;
  workspace: string;
  sandbox: SandboxMode;
  /** CLAUDE_CONFIG_DIR for the runner (session transcripts live here). */
  claudeConfigDir: string;
  logFile: string;
  env: Record<string, string>;
}

export type RunnerLauncher = (spec: LaunchSpec) => Promise<RunnerTransport>;

/** Wrap a child process speaking the JSONL protocol on stdin/stdout; stderr goes to `logFile`. */
export async function childProcessTransport(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string },
): Promise<RunnerTransport> {
  await mkdir(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile, { flags: "a" });
  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messageHandlers: ((msg: FromRunner) => void)[] = [];
  const closeHandlers: ((code: number | null) => void)[] = [];
  const parse = createLineParser<FromRunner>(
    (msg) => {
      for (const h of messageHandlers) h(msg);
    },
    (line) => log.write(`[stdout:invalid] ${line}\n`),
  );
  child.stdout?.on("data", parse);
  child.stderr?.pipe(log, { end: false });
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    log.end();
    for (const h of closeHandlers) h(code);
  };
  child.on("close", (code) => close(code));
  child.on("error", (err) => {
    log.write(`[spawn error] ${err.message}\n`);
    close(null);
  });
  child.stdin?.on("error", () => {});
  return {
    pid: child.pid,
    send(msg) {
      if (!closed) child.stdin?.write(encodeMessage(msg));
    },
    onMessage(cb) {
      messageHandlers.push(cb);
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

/** The runner's side of an in-process transport pair (used by FakeRunner and tests). */
export interface RunnerSide {
  send(msg: FromRunner): void;
  onMessage(cb: (msg: ToRunner) => void): void;
  close(code: number): void;
  readonly killed: boolean;
}

/**
 * Two connected in-process endpoints. Messages are JSON round-tripped and delivered
 * asynchronously, like a real pipe.
 */
export function createTransportPair(): { orchestrator: RunnerTransport; runner: RunnerSide } {
  const toOrchestrator: ((msg: FromRunner) => void)[] = [];
  const toRunner: ((msg: ToRunner) => void)[] = [];
  const closeHandlers: ((code: number | null) => void)[] = [];
  let closed = false;
  let killed = false;
  const deliver = <T>(handlers: ((m: T) => void)[], msg: T) => {
    const copy = JSON.parse(JSON.stringify(msg)) as T;
    setImmediate(() => {
      for (const h of handlers) h(copy);
    });
  };
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    setImmediate(() => {
      for (const h of closeHandlers) h(code);
    });
  };
  return {
    orchestrator: {
      send: (msg) => {
        if (!closed) deliver(toRunner, msg);
      },
      onMessage: (cb) => toOrchestrator.push(cb),
      onClose: (cb) => closeHandlers.push(cb),
      kill: () => {
        killed = true;
        close(null);
      },
    },
    runner: {
      send: (msg) => {
        if (!closed) deliver(toOrchestrator, msg);
      },
      onMessage: (cb) => toRunner.push(cb),
      close: (code) => close(code),
      get killed() {
        return killed;
      },
    },
  };
}
