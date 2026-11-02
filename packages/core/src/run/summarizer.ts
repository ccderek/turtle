import type { TokenUsage } from "../db/types.js";
import type { DiffStat } from "../git/store.js";

export interface SummaryInput {
  /** The run's prompt (what the human asked for). */
  intent: string;
  /** Why this checkpoint is being written, e.g. "rule:maxToolCalls" or "stop". */
  trigger: string;
  stat: DiffStat;
  changedPaths: string[];
  /** Unified diff since the last semantic checkpoint, already truncated. */
  diff: string;
  toolCalls: { name: string; input: string }[];
  lastAssistantText: string | null;
}

export interface Summary {
  title: string;
  body: string;
  /** Present when a model wrote the summary (for overhead accounting, exit criterion E4). */
  usage?: TokenUsage & { model: string; costUsd: number };
}

export interface Summarizer {
  summarize(input: SummaryInput): Promise<Summary>;
}

/** Deterministic summary from the diff and tool calls. Used without an API key and in tests. */
export class HeuristicSummarizer implements Summarizer {
  async summarize(input: SummaryInput): Promise<Summary> {
    const { stat, changedPaths } = input;
    let title: string;
    if (stat.filesChanged === 0) {
      title = input.lastAssistantText ? firstLine(input.lastAssistantText) : "No file changes";
    } else {
      const shown = changedPaths.slice(0, 3).join(", ");
      const more = changedPaths.length > 3 ? ` and ${changedPaths.length - 3} more` : "";
      title = `Change ${shown}${more} (+${stat.linesAdded} −${stat.linesDeleted})`;
    }
    const counts = new Map<string, number>();
    for (const t of input.toolCalls) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const tools = [...counts].map(([n, c]) => `${n}×${c}`).join(", ");
    const lines = [`Auto checkpoint (${input.trigger}).`];
    if (tools) lines.push(`Tools: ${tools}.`);
    if (input.lastAssistantText) lines.push(`Agent: ${firstLine(input.lastAssistantText)}`);
    return { title: truncate(title, 72), body: lines.join("\n") };
  }
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
