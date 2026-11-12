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
};
