import { useState } from "react";
import type { Ctx, Selection } from "./App.js";
import { post } from "./api.js";
import { ago, duration, firstLine, money, STATUS_LABEL, statusTone } from "./format.js";

const KIND_LABEL: Record<string, string> = {
  need_decision: "Question",
  blocked: "Blocked",
  failed: "Failed",
  tests_failing: "Tests failing",
  budget: "Budget",
};

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem("turtle.dismissed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({ ctx, selection }: { ctx: Ctx; selection: Selection | null }) {
  const { state, short, select, toast } = ctx;
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      window.localStorage.setItem("turtle.dismissed", JSON.stringify([...next].slice(-200)));
    } catch {}
  };
  const attention = state.attention.filter((a) => !dismissed.has(a.id));
  const running = state.agents.filter((a) => a.status === "running" || a.status === "starting");
  const branches = [...state.branches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
  const branchLabel = (id: string) => {
    const b = state.branches.find((x) => x.id === id);
    return b?.name ?? short(id);
  };

  const stop = async (branchId: string) => {
    try {
      await post(`/api/branches/${branchId}/stop`);
      toast("Stopping at the next tool boundary…", "info");
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  return (
    <nav className="sidebar" aria-label="Attention">
      <section>
        <h3>
          Needs you <span className="count">{attention.length}</span>
        </h3>
        {attention.length === 0 && <p className="muted small pad">Nothing is waiting for you.</p>}
        {attention.map((item) => (
          <div
            key={item.id}
            className={`card attn ${statusTone(item.kind === "tests_failing" ? "blocked" : item.kind === "budget" ? "blocked" : item.kind)}`}
          >
            <button
              type="button"
              className="card-main"
              onClick={() =>
                item.nodeId
                  ? select({
                      type: "node",
                      id: item.nodeId,
                      compose: item.kind === "need_decision" || item.kind === "blocked",
                    })
                  : select({ type: "branch", id: item.branchId })
              }
            >
              <span className="card-top">
                <span className="kind">{KIND_LABEL[item.kind]}</span>
                <span className="muted small">
                  {branchLabel(item.branchId)} · {ago(item.at)}
                </span>
              </span>
              <span className="card-title">{item.title}</span>
              {item.detail && (
                <span className="card-detail">{firstLine(item.detail).slice(0, 160)}</span>
              )}
            </button>
            {(item.kind === "failed" || item.kind === "budget") && (
              <button type="button" className="link small" onClick={() => dismiss(item.id)}>
                Dismiss
              </button>
            )}
          </div>
        ))}
      </section>

      <section>
        <h3>
          Running <span className="count">{running.length}</span>
        </h3>
        {running.length === 0 && <p className="muted small pad">No agent is working.</p>}
        {running.map((a) => {
          const b = state.branches.find((x) => x.id === a.branchId);
          return (
            <div
              key={a.id}
              className={`card run${selection?.type === "branch" && selection.id === a.branchId ? " selected" : ""}`}
            >
              <button
                type="button"
                className="card-main"
                onClick={() => select({ type: "branch", id: a.branchId })}
              >
                <span className="card-top">
                  <span className="kind run-dot">{branchLabel(a.branchId)}</span>
                  <span className="muted small">
                    {duration(a.startedAt, null)} · {money(a.costUsd)}
                  </span>
                </span>
                <span className="card-title">{firstLine(a.prompt)}</span>
                {b && (
                  <span className="card-detail muted">
                    {firstLine(nodeById.get(b.checkpointHeadId ?? "")?.summary) || "starting"}
                    {b.pendingSteps ? ` · +${b.pendingSteps} steps` : ""}
                  </span>
                )}
              </button>
              <button type="button" className="link small danger" onClick={() => stop(a.branchId)}>
                Stop
              </button>
            </div>
          );
        })}
      </section>

      <section>
        <h3>
          Branches <span className="count">{branches.length}</span>
        </h3>
        <ul className="branch-list">
          {branches.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className={selection?.type === "branch" && selection.id === b.id ? "selected" : ""}
                onClick={() => select({ type: "branch", id: b.id })}
              >
                <span className={`dot ${statusTone(b.status)}`} />
                <span className="name">{b.name ?? short(b.id)}</span>
                <span className="muted small">{STATUS_LABEL[b.status] ?? b.status}</span>
                <span className="muted small right">{money(b.costUsd)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </nav>
  );
}
