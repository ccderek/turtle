import type { NodeStatus, TurtleNode } from "@turtle/core";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export function statusColor(status: NodeStatus | string): (s: string) => string {
  switch (status) {
    case "done":
      return c.green;
    case "need_decision":
    case "blocked":
      return c.yellow;
    case "killed":
    case "failed":
      return c.red;
    default:
      return c.blue;
  }
}

export function firstLine(s: string | null | undefined): string {
  return (s ?? "").split("\n")[0] ?? "";
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function stat(n: Pick<TurtleNode, "linesAdded" | "linesDeleted" | "filesChanged">): string {
  if (!n.filesChanged) return "";
  return `+${n.linesAdded ?? 0} −${n.linesDeleted ?? 0} ${n.filesChanged}f`;
}

export function marker(n: TurtleNode): string {
  if (n.kind === "root") return c.magenta("◉");
  if (n.kind === "micro") return c.dim("·");
  if (n.summarySource === "rule_auto") return c.cyan("◇");
  return c.cyan("◆");
}

/** One-line description of a node used by `run`, `log` and `status`. */
export function nodeLine(n: TurtleNode, short: (id: string) => string, width = 60): string {
  const status =
    n.kind === "micro" || n.kind === "root" ? "" : statusColor(n.status)(n.status.padEnd(14));
  const auto = n.summarySource === "rule_auto" ? c.dim(" (auto)") : "";
  const tests =
    n.tests === "fail"
      ? c.red(" tests✗")
      : n.tests === "pass" && n.kind !== "micro"
        ? c.green(" tests✓")
        : "";
  const title =
    n.kind === "micro" ? c.dim(firstLine(n.summary)) : truncate(firstLine(n.summary), width);
  const s = stat(n);
  return `${marker(n)} ${c.bold(short(n.id).padEnd(6))} ${status}${title}${auto}${s ? c.dim(`  ${s}`) : ""}${tests}`;
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function money(usd: number | null | undefined): string {
  return usd === null || usd === undefined ? "—" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}
