import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Ctx } from "./App.js";
import { post } from "./api.js";
import { Composer } from "./Composer.js";
import { ago, duration, firstLine, money, STATUS_LABEL, statusTone } from "./format.js";
import { PanelShell } from "./NodePanel.js";
import { Transcript } from "./Transcript.js";
import { useAgentLogs } from "./useAgentLogs.js";

/** A branch and its live conversation: every run (agent) on it, oldest first. */
export function BranchPanel({ ctx, branchId }: { ctx: Ctx; branchId: string }) {
  const { state, short, select, version, toast } = ctx;
  const branch = state.branches.find((b) => b.id === branchId);
  const agents = useMemo(
    () =>
      state.agents
        .filter((a) => a.branchId === branchId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [state.agents, branchId],
  );
  const logs = useAgentLogs(agents, version);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current?.closest(".panel-scroll");
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    const el = scroller.current?.closest(".panel-scroll");
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const nodes = useMemo(() => new Map(state.nodes.map((n) => [n.id, n])), [state.nodes]);

  if (!branch) {
    return (
      <PanelShell title="Branch" onClose={() => select(null)}>
        <p className="muted pad">Unknown branch.</p>
      </PanelShell>
    );
  }

  const running = branch.status === "running";
  const head = branch.checkpointHeadId ? nodes.get(branch.checkpointHeadId) : undefined;
  const forkedFrom = branch.forkedFromNodeId;

  const stop = async () => {
    try {
      await post(`/api/branches/${branch.id}/stop`);
      toast("Stopping at the next tool boundary… (press again to force)", "info");
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  return (
    <PanelShell
      onClose={() => select(null)}
      title={
        <>
          <span className={`badge ${statusTone(branch.status)}`}>
            {STATUS_LABEL[branch.status] ?? branch.status}
          </span>
          <strong>{branch.name ?? `branch ${short(branch.id)}`}</strong>
          <span className="muted small">{money(branch.costUsd)}</span>
        </>
      }
    >
      <div className="pad branch-head">
        <dl className="facts">
          <dt>Started</dt>
          <dd>
            {ago(branch.createdAt)}
            {forkedFrom ? (
              <>
                {" "}
                · forked from{" "}
                <button
                  type="button"
                  className="link mono"
                  onClick={() => select({ type: "node", id: forkedFrom })}
                >
                  {short(forkedFrom)}
                </button>
              </>
            ) : (
              " · from your working copy"
            )}
          </dd>
          <dt>Latest</dt>
          <dd>
            {head ? (
              <button
                type="button"
                className="link"
                onClick={() => select({ type: "node", id: head.id })}
              >
                {firstLine(head.summary) || short(head.id)}
              </button>
            ) : (
              "—"
            )}
            {branch.pendingSteps > 0 && (
              <span className="muted"> · +{branch.pendingSteps} steps since</span>
            )}
          </dd>
          <dt>Runs</dt>
          <dd>
            {agents.map((a) => (
              <div key={a.id} className="small">
                <span className={`dot ${statusTone(a.status)}`} /> {a.model ?? "default model"} ·{" "}
                {a.sandbox} · {duration(a.startedAt, a.endedAt)} · {money(a.costUsd)}
                {a.maxBudgetUsd ? <span className="muted"> of {money(a.maxBudgetUsd)}</span> : null}
              </div>
            ))}
          </dd>
          {branch.lastError && (
            <>
              <dt>Error</dt>
              <dd className="bad pre">{branch.lastError}</dd>
            </>
          )}
        </dl>
        {running && (
          <button type="button" className="danger" onClick={stop}>
            Stop agent
          </button>
        )}
      </div>

      <div ref={scroller} className="live">
        {agents.map((a, i) => (
          <section key={a.id} className="run-section">
            <div className="msg user prompt">
              <span className="who">
                You · {i === 0 ? (forkedFrom ? "fork" : "new run") : "continue"} ·{" "}
                {ago(a.startedAt)}
              </span>
              {a.prompt}
            </div>
            <Transcript
              items={logs[a.id]?.items ?? []}
              nodes={nodes}
              short={short}
              onSelectNode={(id) => select({ type: "node", id })}
              live={a.status === "running" || a.status === "starting"}
            />
          </section>
        ))}
      </div>

      {!running && branch.headNodeId && (
        <div className="pad compose-box sticky">
          <Composer
            ctx={ctx}
            mode="continue"
            from={branch.headNodeId}
            placeholder={
              head?.status === "need_decision" ? "Your answer…" : "Continue this branch…"
            }
            submitLabel={
              head?.status === "need_decision" || head?.status === "blocked" ? "Answer" : "Continue"
            }
          />
        </div>
      )}
    </PanelShell>
  );
}
