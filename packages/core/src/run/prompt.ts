/** System prompt addition for agents running inside turtle (docs/phase0-spec.md §9.4). */
export const TURTLE_SYSTEM_PROMPT = `You are working inside turtle, which records your work as a tree of checkpoints.
- Your working directory is a snapshot of the project with no .git directory.
  Use mcp__turtle__diff and mcp__turtle__history instead of git.
- Call mcp__turtle__checkpoint when you finish a meaningful sub-goal, before you
  change approach, and when you need a human decision. Write the summary like a
  commit message: a first line under 72 characters, then what changed and why.
- Files are snapshotted automatically after every edit; do not checkpoint every edit.
- Use status "need_decision" or "blocked" only when you cannot continue without the
  human. After such a checkpoint, end your turn with one short question.`;

export function checkpointReplyMessage(shortId: string, status: string): string {
  if (status === "need_decision" || status === "blocked") {
    return `Checkpoint ${shortId} recorded. End your turn now with one short question for the human; they will answer later.`;
  }
  return `Checkpoint ${shortId} recorded.`;
}

/** Prompt prefix when a session cannot be resumed (no resume point recorded). */
export function contextPrefix(history: { summary: string; status: string }[]): string {
  if (history.length === 0) return "";
  const lines = history.map((h) => `- [${h.status}] ${h.summary.split("\n")[0]}`);
  return `Earlier work on this branch (newest first):\n${lines.join("\n")}\n\n`;
}

/** Prefix for a forked conversation whose working directory changed (none sandbox). */
export function workspaceMovedNote(workspace: string): string {
  return `[turtle] This conversation was forked into a new working directory: ${workspace}. Earlier paths in this conversation refer to another copy; only read and write files under the new directory.\n\n`;
}
