import type { NodeStatus } from "@turtle/server/api";

export const firstLine = (s: string | null | undefined): string => (s ?? "").split("\n")[0] ?? "";

export const restLines = (s: string | null | undefined): string => {
  const t = s ?? "";
  const i = t.indexOf("\n");
  return i === -1 ? "" : t.slice(i + 1).trim();
};

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(fromIso: string, toIso: string | null, now = Date.now()): string {
  const s = Math.round(((toIso ? Date.parse(toIso) : now) - Date.parse(fromIso)) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Shortest unique prefixes (at least 4 characters) for display. */
export function shortIds(ids: string[]): (id: string) => string {
  const sorted = [...new Set(ids)].sort();
  const map = new Map<string, string>();
  sorted.forEach((id, i) => {
    const common = (a: string | undefined) => {
      if (!a) return 0;
      let k = 0;
      while (k < id.length && a[k] === id[k]) k++;
      return k;
    };
    const len = Math.max(4, common(sorted[i - 1]) + 1, common(sorted[i + 1]) + 1);
    map.set(id, id.slice(0, len));
  });
  return (id) => map.get(id) ?? id.slice(0, 6);
}

export const STATUS_LABEL: Record<string, string> = {
  progress: "progress",
  done: "done",
  need_decision: "needs decision",
  blocked: "blocked",
  killed: "stopped",
  failed: "failed",
  running: "running",
  idle: "waiting",
  starting: "starting",
};

export function statusTone(status: NodeStatus | string): string {
  switch (status) {
    case "done":
      return "ok";
    case "need_decision":
    case "idle":
      return "ask";
    case "blocked":
      return "warn";
    case "failed":
      return "bad";
    case "killed":
      return "mute";
    case "running":
    case "starting":
      return "run";
    default:
      return "info";
  }
}
