import type { LiveEvent } from "@turtle/server/api";
import { useEffect, useRef, useState } from "react";

export type * from "@turtle/server/api";

export class ApiError extends Error {}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok)
    throw new ApiError((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await fetch(path, { signal: signal ?? null, cache: "no-store" }));
}

export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method: "POST",
      // The custom header makes cross-site writes impossible (the server never answers a preflight).
      headers: { "content-type": "application/json", "x-turtle": "1" },
      body: JSON.stringify(body),
    }),
  );
}

export type Connection = "connecting" | "live" | "offline";

/** Server-sent events: `change` whenever the database changes, `log` for run warnings. */
export function useLive(onEvent: (e: LiveEvent) => void): Connection {
  const [conn, setConn] = useState<Connection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConn("live");
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as LiveEvent);
      } catch {}
    };
    return () => es.close();
  }, []);
  return conn;
}
