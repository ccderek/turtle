export const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  todo: { label: "to do", tone: "mute" },
  running: { label: "running", tone: "run" },
  paused: { label: "paused", tone: "mute" },
  need_decision: { label: "needs you", tone: "ask" },
  blocked: { label: "blocked", tone: "warn" },
  done: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  abandoned: { label: "abandoned (kept)", tone: "mute" },
  dropped: { label: "dropped", tone: "mute" },
};

export const KIND_LABEL: Record<string, string> = {
  finding: "finding",
  decision: "decision",
  question: "question",
  output: "output",
  lesson: "lesson",
  check: "check",
  recipe: "recipe",
};

/** A task's status label; a discussion waits for "your turn" and ends "concluded". */
export function statusOf(c: { status?: string | null; role?: string }): {
  label: string;
  tone: string;
} {
  const st = TASK_STATUS[c.status ?? "todo"] ?? { label: c.status ?? "", tone: "mute" };
  if (c.role !== "discussion") return st;
  if (c.status === "need_decision") return { label: "your turn", tone: "ask" };
  if (c.status === "done") return { label: "concluded", tone: "ok" };
  return st;
}
