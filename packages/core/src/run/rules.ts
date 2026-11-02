import type { RulesConfig } from "../config.js";
import type { TestStatus } from "../db/types.js";

/** Activity since the last semantic checkpoint. */
export interface RuleState {
  toolCalls: number;
  elapsedMs: number;
  changedLines: number;
  changedFiles: number;
  /** Test status at the last semantic checkpoint and now. */
  testsAtCheckpoint: TestStatus | null;
  testsNow: TestStatus | null;
}

/**
 * Which fallback rule (if any) asks for a semantic checkpoint now
 * (docs/phase0-spec.md §13). Returns the rule name, e.g. "maxToolCalls".
 */
export function evaluateRules(state: RuleState, rules: RulesConfig): string | null {
  if (
    rules.testFlip &&
    state.testsNow !== null &&
    state.testsNow !== "none" &&
    state.testsAtCheckpoint !== null &&
    state.testsAtCheckpoint !== "none" &&
    state.testsNow !== state.testsAtCheckpoint
  ) {
    return "testFlip";
  }
  if (state.toolCalls >= rules.maxToolCalls) return "maxToolCalls";
  if (state.changedLines >= rules.maxChangedLines) return "maxChangedLines";
  if (state.changedFiles >= rules.maxChangedFiles) return "maxChangedFiles";
  if (state.elapsedMs >= rules.maxMinutes * 60_000) return "maxMinutes";
  return null;
}

/** Tools that never change files; no snapshot is taken after them. */
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
  "mcp__turtle__checkpoint",
  "mcp__turtle__diff",
  "mcp__turtle__history",
]);

export function isMutatingTool(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Best-effort test result from a Bash tool call that ran the configured test command.
 * Claude Code reports a non-zero exit as a failed tool call (PostToolUseFailure) and its
 * Bash output has no exit code, so: failed call → "fail"; otherwise the output decides,
 * defaulting to "pass". Returns null for unrelated calls.
 */
export function detectTestResult(
  testCommand: string | undefined,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  failed = false,
): TestStatus | null {
  if (!testCommand || toolName !== "Bash") return null;
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command !== "string" || !command.includes(testCommand)) return null;

  if (toolResponse && typeof toolResponse === "object") {
    const r = toolResponse as Record<string, unknown>;
    if (r.interrupted === true) return null;
    for (const key of ["exitCode", "exit_code", "returnCode", "return_code", "code"]) {
      if (typeof r[key] === "number") return r[key] === 0 ? "pass" : "fail";
    }
  }
  if (failed) return "fail";
  const text =
    typeof toolResponse === "string"
      ? toolResponse
      : toolResponse && typeof toolResponse === "object"
        ? Object.values(toolResponse as Record<string, unknown>)
            .filter((v): v is string => typeof v === "string")
            .join("\n")
        : "";
  if (/\b(\d+ (failed|failing)|FAIL\b|failures?:\s*[1-9]|Tests?:.*\bfailed\b)/.test(text)) {
    return "fail";
  }
  return "pass";
}
