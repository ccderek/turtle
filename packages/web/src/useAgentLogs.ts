import { useEffect, useRef, useState } from "react";
import { type AgentView, get, type TranscriptItem, type TranscriptResponse } from "./api.js";

export interface AgentLog {
  items: TranscriptItem[];
  lastSeq: number;
}

/**
 * The conversations of some agents, kept up to date: every agent's log once, then new
 * messages of those still running, on every change (`version`).
 */
export function useAgentLogs(agents: AgentView[], version: number): Record<string, AgentLog> {
  const [logs, setLogs] = useState<Record<string, AgentLog>>({});
  const logsRef = useRef(logs);
  logsRef.current = logs;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const a of agents) {
        const have = logsRef.current[a.id];
        if (
          have &&
          a.status !== "running" &&
          a.status !== "starting" &&
          have.items.some((i) => i.kind === "result")
        )
          continue;
        try {
          const r = await get<TranscriptResponse>(
            `/api/agents/${a.id}/transcript?after=${have?.lastSeq ?? 0}`,
          );
          if (cancelled) return;
          if (r.items.length || !have) {
            setLogs((prev) => {
              const cur = prev[a.id] ?? { items: [], lastSeq: 0 };
              if (cur.lastSeq >= r.lastSeq && cur.items.length) return prev;
              return { ...prev, [a.id]: { items: [...cur.items, ...r.items], lastSeq: r.lastSeq } };
            });
          }
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agents, version]);
  return logs;
}
