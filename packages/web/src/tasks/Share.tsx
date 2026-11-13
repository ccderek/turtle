import { useEffect, useRef, useState } from "react";
import { type ExportSummaryResponse, type GateResponse, get, post } from "../api.js";
import type { GraphCtx } from "./TasksView.js";

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return { ref, onClose };
}

const QUESTIONS = [
  ["goal", "What the goal was"],
  ["results", "The results, and the evidence for them"],
  ["decisions", "What was decided"],
  ["openQuestions", "What is still open"],
] as const;

/**
 * Share a task or goal (docs/phase2-spec.md §10): what the file holds and what was redacted,
 * the download, and your judgment of it for the gate (G3).
 */
export function ShareDialog({
  ctx,
  id,
  onClose,
}: {
  ctx: GraphCtx;
  id: string;
  onClose: () => void;
}) {
  const { ref } = useModal(onClose);
  const [s, setS] = useState<ExportSummaryResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [clear, setClear] = useState({
    goal: false,
    results: false,
    decisions: false,
    openQuestions: false,
  });
  const [notes, setNotes] = useState("");
  useEffect(() => {
    get<ExportSummaryResponse>(`/api/concepts/${id}/export`).then(setS, (e: Error) =>
      setErr(e.message),
    );
  }, [id]);
  const counts = s
    ? Object.entries(s.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(" · ")
    : "";
  const redactions = s ? Object.entries(s.redactions) : [];
  return (
    <dialog
      ref={ref}
      className="dialog share-dialog"
      onClose={onClose}
      aria-labelledby="share-title"
    >
      <div className="dialog-head">
        <h2 id="share-title">Share as a file</h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {err && <p className="bad small">{err}</p>}
      {!s && !err && <p className="muted">Preparing…</p>}
      {s && (
        <>
          <p className="small">
            One HTML file with <b>{s.title}</b> and everything under it: briefs, findings with their
            evidence, decisions, questions, lessons, checks and recipes. No agent transcripts or
            environment variables.
          </p>
          <dl className="facts small">
            <dt>Holds</dt>
            <dd>{counts}</dd>
            <dt>Evidence</dt>
            <dd>
              {s.inlined} file(s) inside, {s.listed} listed by path and hash ·{" "}
              {Math.max(1, Math.round(s.bytes / 1024))} KB
            </dd>
            <dt>Redacted</dt>
            <dd>
              {redactions.length
                ? redactions.map(([k, v]) => `${v} ${k}`).join(" · ")
                : "nothing needed redacting"}
            </dd>
          </dl>
          {s.leaks.length > 0 ? (
            <p className="ask-note small">Still looks sensitive: {s.leaks.join("; ")}</p>
          ) : (
            <p className="ok small">✓ No secrets or home paths left in the file.</p>
          )}
          <div className="composer-actions">
            <a
              className="button primary"
              href={`/api/concepts/${id}/export?format=html`}
              download={s.fileName}
              onClick={() => setDownloaded(true)}
            >
              Download {s.fileName}
            </a>
          </div>
          <form
            className="stack judge"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post(`/api/exports/${id}/judge`, { clear, notes });
                ctx.toast("Judgment recorded for the gate (G3)", "ok");
                onClose();
              } catch (e2) {
                ctx.toast((e2 as Error).message, "bad");
              }
            }}
          >
            <h4>
              {downloaded ? "Now read it." : "After reading it:"} Is it clear, from the file alone…
            </h4>
            {QUESTIONS.map(([k, label]) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={clear[k]}
                  onChange={(e) => setClear((c) => ({ ...c, [k]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
            <input
              id={`judge-notes-${id}`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What was unclear (optional)"
            />
            <div className="composer-actions">
              <button type="submit">Record my judgment</button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}

/** The Phase 2 gate (docs/phase2-spec.md §1, §15), from what turtle recorded. */
export function GateDialog({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const { ref } = useModal(onClose);
  const [g, setG] = useState<GateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    get<GateResponse>("/api/gate").then(setG, (e: Error) => setErr(e.message));
  }, [ctx.version]);
  const mark = (v: boolean | null) => (v === true ? "pass" : v === false ? "fail" : "—");
  return (
    <dialog ref={ref} className="dialog gate-dialog" onClose={onClose} aria-labelledby="gate-title">
      <div className="dialog-head">
        <h2 id="gate-title">
          Phase 2 gate {g && <span className={`badge gate-${mark(g.pass)}`}>{mark(g.pass)}</span>}
        </h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="muted small">
        Measured from what turtle recorded; nothing here asks you to do anything except judge
        exports (G3) and run the audit (G2).
      </p>
      {err && <p className="bad small">{err}</p>}
      {g?.groups.map((grp) => (
        <section key={grp.id} className="gate-group">
          <h3>
            <span className="mono">{grp.id === "latency" ? "Redirect" : grp.id}</span> {grp.title}{" "}
            <span className="muted small">{grp.question}</span>
            {grp.pass !== null && (
              <span className={`badge gate-${mark(grp.pass)}`}>{mark(grp.pass)}</span>
            )}
          </h3>
          <table className="gate-table">
            <tbody>
              {grp.metrics.map((m) => (
                <tr key={m.id}>
                  <td className={`gate-mark gate-${mark(m.pass)}`}>
                    {m.pass === true ? "✓" : m.pass === false ? "✗" : ""}
                  </td>
                  <td>
                    {m.label}
                    {m.detail && <div className="muted small">{m.detail}</div>}
                  </td>
                  <td className="gate-value">{m.display}</td>
                  <td className="muted small">{m.target ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {grp.id === "G2" && (
            <div className="actions-row">
              <button
                type="button"
                disabled={!g.canAudit || g.auditing}
                onClick={async () => {
                  try {
                    await post("/api/audit", {});
                    ctx.toast("Auditing finished tasks with a small model", "info");
                    ctx.refresh();
                  } catch (e) {
                    ctx.toast((e as Error).message, "bad");
                  }
                }}
              >
                {g.auditing ? "Auditing…" : "Run the audit"}
              </button>
              {!g.canAudit && (
                <span className="muted small">
                  The audit calls a model: start turtle ui with ANTHROPIC_API_KEY set, or run{" "}
                  <code>turtle audit</code>.
                </span>
              )}
            </div>
          )}
          {grp.id === "G3" && (
            <p className="muted small">Judge an export with Share… on a task or goal.</p>
          )}
        </section>
      ))}
    </dialog>
  );
}
