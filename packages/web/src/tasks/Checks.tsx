import { useState } from "react";
import { type CheckRunResponse, type Concept, post } from "../api.js";
import { ago } from "../format.js";
import type { GraphCtx } from "./TasksView.js";

const TEMPLATE = `# Runs in the task's working directory at every checkpoint.
# Exit 0 when the work is acceptable; otherwise print why and exit 1.
import pathlib, sys

problems = []
for path in pathlib.Path("results").glob("*.csv"):
    if "out_of_sample" not in path.read_text():
        problems.append(f"{path}: no out-of-sample score")

if problems:
    print("\\n".join(problems))
    sys.exit(1)
print("ok")
`;

/** Checks that apply to a concept: on it and on its ancestors (client-side, from the graph). */
export function checksFor(ctx: GraphCtx, id: string, states = ["active"]): Concept[] {
  const out: Concept[] = [];
  let cur = ctx.byId.get(id);
  while (cur) {
    for (const k of ctx.kids.get(cur.id) ?? [])
      if (k.kind === "check" && states.includes(k.checkState ?? "active")) out.push(k);
    cur = cur.parentId ? ctx.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** "ok" / "failed" / null (no result yet) for a task's checks in scope. */
export function checkVerdict(
  ctx: GraphCtx,
  task: Concept,
): { failed: number; total: number } | null {
  const checks = checksFor(ctx, task.id);
  const results = checks.map((c) => task.checkResults?.[c.id]).filter(Boolean);
  if (!checks.length || !results.length) return null;
  return { failed: results.filter((r) => r && !r.ok).length, total: checks.length };
}

/** Write a new check: on a lesson (it enforces it) or on a task or goal (its subtree). */
export function CheckForm({
  ctx,
  on,
  label,
  onDone,
}: {
  ctx: GraphCtx;
  on: string;
  label: string;
  onDone?: () => void;
}) {
  const lesson = ctx.byId.get(on)?.kind === "lesson" ? ctx.byId.get(on) : undefined;
  const [title, setTitle] = useState(lesson ? lesson.title : "");
  const [file, setFile] = useState("check.py");
  const [script, setScript] = useState(TEMPLATE);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack check-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const c = await post<Concept>("/api/checks", { on, title, file, script });
          ctx.toast("Check added: it runs at every checkpoint under it", "ok");
          ctx.refresh();
          onDone?.();
          ctx.select(c.id);
        } catch (err) {
          ctx.toast((err as Error).message, "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        {label}
        <input
          id={`check-title-${on}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What it verifies, e.g. every result reports an out-of-sample score"
        />
      </label>
      <label className="field">
        File name{" "}
        <span className="muted small">
          (.py runs with python3, .sh with bash, .js/.mjs with node)
        </span>
        <input
          id={`check-file-${on}`}
          className="mono"
          value={file}
          onChange={(e) => setFile(e.target.value)}
        />
      </label>
      <textarea
        id={`check-script-${on}`}
        aria-label="Check script"
        className="mono code-input"
        rows={12}
        spellCheck={false}
        value={script}
        onChange={(e) => setScript(e.target.value)}
      />
      <div className="composer-actions">
        {onDone && (
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="primary"
          disabled={busy || !title.trim() || !script.trim()}
        >
          Add check
        </button>
      </div>
    </form>
  );
}

function ResultLine({ ctx, check, task }: { ctx: GraphCtx; check: Concept; task: Concept }) {
  const r = task.checkResults?.[check.id];
  return (
    <li className={`check-row${r ? (r.ok ? " ok" : " bad") : ""}`}>
      <span className="check-mark" aria-hidden="true">
        {r ? (r.ok ? "✓" : "✗") : "·"}
      </span>
      <div className="check-main">
        <button type="button" className="link" onClick={() => ctx.select(check.id)}>
          {check.title}
        </button>{" "}
        <span className="muted small mono">{check.file}</span>
        {r ? (
          <details open={!r.ok}>
            <summary className="muted small">
              {r.ok ? "passed" : "failed"} {ago(r.at)}
              {r.checkpointId ? ` · checkpoint ${ctx.codeShort(r.checkpointId)}` : ""}
            </summary>
            <pre className="check-output">{r.output}</pre>
          </details>
        ) : (
          <span className="muted small"> · not run yet</span>
        )}
      </div>
    </li>
  );
}

/** A task's checks in scope, their latest results, "Run now" and "Add a check". */
export function TaskChecks({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const checks = checksFor(ctx, c.id);
  const proposed = checksFor(ctx, c.id, ["proposed"]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const canRun = checks.length > 0 && !!c.branches?.length && c.status !== "running";
  return (
    <section className="sec">
      <h4>Checks</h4>
      {checks.length === 0 ? (
        <p className="muted small">
          No checks apply yet. A check is a script turtle runs at every checkpoint; the task cannot
          end done while one fails.
        </p>
      ) : (
        <ul className="checks">
          {checks.map((k) => (
            <ResultLine key={k.id} ctx={ctx} check={k} task={c} />
          ))}
        </ul>
      )}
      {proposed.length > 0 && (
        <p className="small">
          {proposed.length} proposed check(s) wait for you:{" "}
          {proposed.map((p) => (
            <button key={p.id} type="button" className="link" onClick={() => ctx.select(p.id)}>
              {p.title}{" "}
            </button>
          ))}
        </p>
      )}
      <div className="actions-row">
        {canRun && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<CheckRunResponse>(`/api/tasks/${c.id}/checks`);
                const failed = r.results.filter((x) => !x.ok).length;
                ctx.toast(
                  failed ? `${failed} check(s) failed` : "All checks pass",
                  failed ? "warn" : "ok",
                );
                ctx.refresh();
              } catch (err) {
                ctx.toast((err as Error).message, "bad");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Running…" : "Run checks now"}
          </button>
        )}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)}>
            Add a check…
          </button>
        )}
      </div>
      {adding && (
        <CheckForm
          ctx={ctx}
          on={c.id}
          label="A check for this task and everything under it"
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/** On a lesson: the checks that enforce it, and a form to write one. */
export function LessonChecks({ ctx, lesson }: { ctx: GraphCtx; lesson: Concept }) {
  const [adding, setAdding] = useState(false);
  const enforcers = ctx.graph.links
    .filter((l) => !l.removed && l.rel === "enforces" && l.to.id === lesson.id)
    .map((l) => ctx.byId.get(l.from))
    .filter((x): x is Concept => !!x && !x.dropped);
  return (
    <section className="sec">
      <h4>Enforced by</h4>
      {enforcers.length === 0 ? (
        <p className="muted small">
          Nothing yet: this lesson is advice in the prompt. A check makes it a rule turtle tests at
          every checkpoint under “{ctx.byId.get(lesson.parentId ?? "")?.title}”.
        </p>
      ) : (
        <ul className="kid-list">
          {enforcers.map((k) => (
            <li key={k.id}>
              <button type="button" className="link-row" onClick={() => ctx.select(k.id)}>
                <span className="leaf-kind check">check</span> {k.title}{" "}
                <span className="muted small">· {k.checkState}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <CheckForm
          ctx={ctx}
          on={lesson.id}
          label="What the check verifies"
          onDone={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Enforce with a check…
        </button>
      )}
    </section>
  );
}

/** A check's own panel: its state, script and results on the tasks it judged. */
export function CheckSection({
  ctx,
  c,
  act,
}: {
  ctx: GraphCtx;
  c: Concept;
  act: (path: string, body: unknown, ok: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [script, setScript] = useState(c.script ?? "");
  const scope = ctx.byId.get(c.parentId ?? "");
  const enforces = ctx.graph.links
    .filter((l) => !l.removed && l.rel === "enforces" && l.from === c.id)
    .map((l) => ctx.byId.get(l.to.id))
    .filter((x): x is Concept => !!x);
  const judged = ctx.graph.concepts.filter((t) => t.kind === "task" && t.checkResults?.[c.id]);
  const state = c.checkState ?? "active";
  const set = (checkState: string, msg: string) =>
    act(`/api/concepts/${c.id}`, { fields: { checkState } }, msg);
  return (
    <>
      <p className="small">
        Runs <span className="mono">{c.file}</span> at every checkpoint of every task under “
        {scope?.title}”.
        {enforces.map((l) => (
          <span key={l.id}>
            {" "}
            Enforces the lesson{" "}
            <button type="button" className="link" onClick={() => ctx.select(l.id)}>
              {l.title}
            </button>
            .
          </span>
        ))}
      </p>
      {state === "proposed" && (
        <p className="ask-note small">
          Proposed by an agent. Read the script: once active it runs on this machine, outside the
          sandbox.
        </p>
      )}
      <div className="actions-row">
        {state !== "active" && (
          <button type="button" className="primary" onClick={() => set("active", "Check active")}>
            {state === "proposed" ? "Activate" : "Reactivate"}
          </button>
        )}
        {state !== "retired" && (
          <button type="button" onClick={() => set("retired", "Check retired")}>
            Retire
          </button>
        )}
        {!editing && (
          <button type="button" onClick={() => setEditing(true)}>
            Edit script
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="stack sec"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act(`/api/concepts/${c.id}`, { fields: { script }, base: c.version }, "Saved")
            )
              setEditing(false);
          }}
        >
          <textarea
            id={`edit-script-${c.id}`}
            aria-label="Check script"
            className="mono code-input"
            rows={14}
            spellCheck={false}
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="composer-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      ) : (
        <pre className="check-script">{c.script}</pre>
      )}
      <section className="sec">
        <h4>Results</h4>
        {judged.length === 0 ? (
          <p className="muted small">Not run on any task yet.</p>
        ) : (
          <ul className="checks">
            {judged.map((t) => {
              const r = t.checkResults?.[c.id];
              return (
                <li key={t.id} className={`check-row${r?.ok ? " ok" : " bad"}`}>
                  <span className="check-mark" aria-hidden="true">
                    {r?.ok ? "✓" : "✗"}
                  </span>
                  <div className="check-main">
                    <button type="button" className="link" onClick={() => ctx.select(t.id)}>
                      {t.title}
                    </button>
                    <span className="muted small"> · {r ? ago(r.at) : ""}</span>
                    {r && !r.ok && <pre className="check-output">{r.output}</pre>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
