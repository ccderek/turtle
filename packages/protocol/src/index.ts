/**
 * Wire protocol between the turtle orchestrator and an agent runner
 * (docs/phase0-spec.md §8). Newline-delimited JSON over the runner's stdin/stdout.
 * Any runner that speaks this protocol is an adapter.
 */

export const PROTOCOL_VERSION = 1;

export type CheckpointStatus = "progress" | "done" | "blocked" | "need_decision";
export type PermissionMode = "bypassPermissions" | "acceptEdits";

export interface RunnerStartOptions {
  model?: string;
  systemPromptAppend: string;
  /** SDK session id to resume. */
  resume?: string;
  /** Message uuid to resume at (fork from a mid-run node). */
  resumeSessionAt?: string;
  forkSession?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  /** Command run in the sandbox before the agent starts (e.g. `npm ci`). */
  setupCommand?: string;
}

export interface ArtifactRef {
  path: string;
  label?: string;
}

// ------------------------------------------------------- orchestrator → runner

export type ToRunner =
  | { t: "start"; prompt: string; options: RunnerStartOptions }
  | { t: "reply"; id: number; ok: true; result: unknown }
  | { t: "reply"; id: number; ok: false; error: string }
  | { t: "exec"; id: number; cmd: string; timeoutSec: number }
  | { t: "interrupt" }
  | { t: "shutdown" };

// ------------------------------------------------------- runner → orchestrator

export interface PostToolUseRequest {
  t: "request";
  id: number;
  kind: "post_tool_use";
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  toolResponse: unknown;
  /** Set when the tool call came from a subagent. */
  agentId?: string;
}

export interface CheckpointRequest {
  t: "request";
  id: number;
  kind: "checkpoint";
  /** tool_use id of the checkpoint tool call, when known. */
  toolUseId?: string;
  summary: string;
  status: CheckpointStatus;
  artifacts?: ArtifactRef[];
}

export interface DiffRequest {
  t: "request";
  id: number;
  kind: "diff";
  /** "branch_start" | "last_checkpoint" | a node id. */
  since?: string;
  path?: string;
}

export interface HistoryRequest {
  t: "request";
  id: number;
  kind: "history";
  limit?: number;
}

export interface StopRequest {
  t: "request";
  id: number;
  kind: "stop";
  lastAssistantMessage?: string;
}

export type RunnerRequest =
  | PostToolUseRequest
  | CheckpointRequest
  | DiffRequest
  | HistoryRequest
  | StopRequest;

export type FromRunner =
  | {
      t: "ready";
      adapter: string;
      level: 0 | 1 | 2;
      capabilities: string[];
      version: string;
    }
  | { t: "sdk"; msg: unknown }
  | RunnerRequest
  | { t: "exec_result"; id: number; exitCode: number; stdout: string; stderr: string }
  | { t: "log"; level: "info" | "warn" | "error"; message: string }
  | { t: "exit"; code: number; error?: string };

// -------------------------------------------------------------------- replies

export interface CheckpointReply {
  nodeId: string;
  /** Text returned to the model as the tool result. */
  message: string;
}

export interface DiffReply {
  diff: string;
  truncated: boolean;
}

export interface HistoryEntry {
  nodeId: string;
  status: string;
  summary: string;
}

// -------------------------------------------------------------------- framing

export function encodeMessage(msg: ToRunner | FromRunner): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Returns a function that accepts stream chunks and calls `onMessage` for every complete
 * JSON line. Lines that are not valid JSON are passed to `onInvalid`.
 */
export function createLineParser<T>(
  onMessage: (msg: T) => void,
  onInvalid: (line: string) => void = () => {},
): (chunk: string | Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          onInvalid(line);
          parsed = undefined;
        }
        if (parsed !== undefined) onMessage(parsed as T);
      }
      nl = buffer.indexOf("\n");
    }
  };
}
