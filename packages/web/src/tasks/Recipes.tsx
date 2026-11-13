import { useState } from "react";
import { type Concept, post } from "../api.js";
import { ago } from "../format.js";
import { ChainInfo, PathReplaySteps } from "./Replay.js";
import type { GraphCtx } from "./TasksView.js";

const STATE_TONE: Record<string, string> = {
  draft: "mute",
  verifying: "run",
  verified: "ok",
  failed: "bad",
};

const fmt = (p: Record<string, string> | undefined) =>
  Object.entries(p ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

/** Recipes of a task, newest first (client-side, from the graph). */
export function recipesOf(ctx: GraphCtx, taskId: string): Concept[] {
  return (ctx.kids.get(taskId) ?? [])
    .filter((k) => k.kind === "recipe")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A task is hardened when one of its recipes is verified. */
export function isHardened(ctx: GraphCtx, taskId: string): boolean {
  return recipesOf(ctx, taskId).some((r) => r.recipeState === "verified");
}

async function call(ctx: GraphCtx, path: string, body: unknown, ok: string) {
  try {
    const r = await post<Concept | { started: boolean }>(path, body);
    if (ok) ctx.toast(ok, "ok");
    ctx.refresh();
    return r;
  } catch (err) {
    ctx.toast((err as Error).message, "bad");
    return null;
  }
}

function ReplayForm({ ctx, r, onDone }: { ctx: GraphCtx; r: Concept; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({ ...(r.params ?? {}) });
  const [title, setTitle] = useState("");
  const names = Object.keys(r.params ?? {});
  return (
    <form
      className="stack replay-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = (await call(
          ctx,
          `/api/recipes/${r.id}/replay`,
          { params: values, ...(title.trim() ? { title } : {}) },
          "Replay added: the recipe runs first, without a model",
        )) as Concept | null;
        if (t) {
          onDone();
          ctx.select(t.id);
        }
      }}
    >
      {names.length === 0 && (
        <p className="muted small">
          This recipe has no parameters: the replay redoes the step as is.
        </p>
      )}
      {names.map((k) => (
        <label key={k} className="field inline-field">
          <span className="mono">{k}</span>
          <input
            id={`param-${r.id}-${k}`}
            className="mono"
            value={values[k] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
          />
        </label>
      ))}
      <input
        id={`replay-title-${r.id}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title of the new task (optional)"
      />
      <div className="composer-actions">
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Replay
        </button>
      </div>
    </form>
  );
}

/** One recipe: state, what it regenerates, verification, Verify and Replay with…. */
export function RecipeCard({ ctx, r, open }: { ctx: GraphCtx; r: Concept; open?: boolean }) {
  const [replaying, setReplaying] = useState(false);
  const state = r.recipeState ?? "draft";
  const v = r.verification;
  return (
    <div className={`recipe-card state-${state}`}>
      <div className="recipe-head">
        <span className={`badge ${STATE_TONE[state] ?? "mute"}`}>{state}</span>
        <button type="button" className="link" onClick={() => ctx.select(r.id)}>
          {r.title}
        </button>
        <span className="muted small mono">{r.file}</span>
      </div>
      <dl className="facts small">
        {Object.keys(r.params ?? {}).length > 0 && (
          <>
            <dt>Parameters</dt>
            <dd className="mono">{fmt(r.params)}</dd>
          </>
        )}
        {(r.outputs ?? []).length > 0 && (
          <>
            <dt>Regenerates</dt>
            <dd className="mono">
              {(r.outputs ?? []).join(", ")}
              {r.tolerance ? (
                <span className="muted"> · numbers within {(r.tolerance * 100).toFixed(1)}%</span>
              ) : null}
            </dd>
          </>
        )}
        {v && (
          <>
            <dt>Verified</dt>
            <dd>
              {v.ok ? "✓ replayed from a clean copy of" : "✗ failed against"} checkpoint{" "}
              <button
                type="button"
                className="link mono"
                onClick={() => ctx.openCode({ type: "node", id: v.checkpointId })}
              >
                {ctx.codeShort(v.checkpointId)}
              </button>{" "}
              <span className="muted">
                · {ago(v.at)} · {(v.ms / 1000).toFixed(1)} s
              </span>
            </dd>
          </>
        )}
      </dl>
      {v && !v.ok && (
        <ul className="problems">
          {v.problems.map((p) => (
            <li key={p} className="small">
              {p}
            </li>
          ))}
        </ul>
      )}
      <details open={open}>
        <summary className="muted small">Script{v?.output ? " and its last output" : ""}</summary>
        <pre className="check-script">{r.script}</pre>
        {v?.output && <pre className="check-output">{v.output}</pre>}
      </details>
      <div className="actions-row">
        <button
          type="button"
          disabled={state === "verifying"}
          onClick={() =>
            call(ctx, `/api/recipes/${r.id}/verify`, {}, "Verifying: replaying from a clean copy")
          }
        >
          {state === "verifying" ? "Verifying…" : state === "draft" ? "Verify" : "Verify again"}
        </button>
        {state === "verified" && !replaying && (
          <button type="button" className="primary" onClick={() => setReplaying(true)}>
            Replay with…
          </button>
        )}
      </div>
      {replaying && <ReplayForm ctx={ctx} r={r} onDone={() => setReplaying(false)} />}
    </div>
  );
}

/** Recipes of a task, and a form to write one. */
export function TaskRecipes({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const list = recipesOf(ctx, c.id);
  const [adding, setAdding] = useState(false);
  return (
    <section className="sec">
      <h4>Recipe</h4>
      {list.length === 0 && !adding && (
        <p className="muted small">
          No recipe yet. A recipe is a script that redoes this step from its checkpoint, with
          parameters; once verified, the step can be replayed (e.g. for another model) without a
          model.
        </p>
      )}
      {list.map((r, i) => (
        <RecipeCard key={r.id} ctx={ctx} r={r} open={i === 0 && r.recipeState === "failed"} />
      ))}
      {adding ? (
        <RecipeForm ctx={ctx} taskId={c.id} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          Add a recipe…
        </button>
      )}
    </section>
  );
}

function RecipeForm({
  ctx,
  taskId,
  onDone,
}: {
  ctx: GraphCtx;
  taskId: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState("redo.sh");
  const [params, setParams] = useState("MODEL=A");
  const [outputs, setOutputs] = useState("");
  const [tolerance, setTolerance] = useState("0");
  const [script, setScript] = useState(
    "set -e\n# Regenerate this step's outputs. Parameters arrive as environment variables.\n",
  );
  return (
    <form
      className="stack check-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const p: Record<string, string> = {};
        for (const kv of params.split(/[,\s]+/).filter(Boolean)) {
          const i = kv.indexOf("=");
          if (i > 0) p[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const r = await call(
          ctx,
          "/api/recipes",
          {
            taskId,
            title,
            file,
            script,
            params: p,
            outputs: outputs
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            tolerance: Number(tolerance) || 0,
          },
          "Recipe added: press Verify to replay it from a clean copy",
        );
        if (r) onDone();
      }}
    >
      <input
        id={`recipe-title-${taskId}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What it redoes, e.g. compile a model for the phone"
      />
      <div className="form-row">
        <label className="field">
          File
          <input
            id={`recipe-file-${taskId}`}
            className="mono"
            value={file}
            onChange={(e) => setFile(e.target.value)}
          />
        </label>
        <label className="field">
          Parameters
          <input
            id={`recipe-params-${taskId}`}
            className="mono"
            value={params}
            onChange={(e) => setParams(e.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          Regenerates <span className="muted small">(comma-separated; may use ${"{MODEL}"})</span>
          <input
            id={`recipe-outputs-${taskId}`}
            className="mono"
            value={outputs}
            onChange={(e) => setOutputs(e.target.value)}
          />
        </label>
        <label className="field">
          Tolerance
          <input
            id={`recipe-tol-${taskId}`}
            className="mono"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
          />
        </label>
      </div>
      <textarea
        id={`recipe-script-${taskId}`}
        aria-label="Recipe script"
        className="mono code-input"
        rows={10}
        spellCheck={false}
        value={script}
        onChange={(e) => setScript(e.target.value)}
      />
      <div className="composer-actions">
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!title.trim() || !script.trim()}>
          Add recipe
        </button>
      </div>
    </form>
  );
}

/** On a replay task: what it replays and what happened. */
export function ReplayInfo({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const spec = c.replay;
  if (!spec) return null;
  const path = !!spec.source;
  const r = spec.recipeId ? ctx.byId.get(spec.recipeId) : undefined;
  const from = path
    ? ctx.byId.get(spec.source?.taskId ?? "")
    : r
      ? ctx.byId.get(r.parentId ?? "")
      : undefined;
  const res = spec.result;
  const after = c.startFrom?.checkpointId === "latest" ? ctx.byId.get(c.startFrom.taskId) : null;
  const where =
    spec.onto === "repo"
      ? " on your repository as it is now"
      : after
        ? ` on the results of “${after.title}”, once it is done`
        : spec.onto === "checkpoint"
          ? " on another task's checkpoint"
          : "";
  return (
    <section className={`sec replay-info${res ? (res.ok ? " replay-ok" : " replay-bad") : ""}`}>
      <h4>Replay</h4>
      <p className="small">
        Redoes{" "}
        {from ? (
          <button type="button" className="link" onClick={() => ctx.select(from.id)}>
            {from.title}
          </button>
        ) : (
          "a task"
        )}
        {where}
        {Object.keys(spec.params).length > 0 && (
          <>
            {" "}
            with <span className="mono">{fmt(spec.params)}</span>
          </>
        )}
        {path
          ? ": code changes applied, results rerun, no model unless a step fails."
          : ", by running its recipe first (no model)."}
      </p>
      <ChainInfo ctx={ctx} c={c} />
      {path && <PathReplaySteps c={c} />}
      {res ? (
        <>
          <p className="small">
            {res.ok ? "✓ Done without a model" : `✗ ${path ? "Stopped" : "The recipe failed"}`}{" "}
            {ago(res.at)}
            {!res.ok &&
              (spec.repairs
                ? "; an agent took over the rest."
                : "; continue the task to let an agent do the rest.")}
            {res.ok &&
              spec.next &&
              (spec.nextStarted ? "; an agent continued with the next step." : "")}
          </p>
          <pre className="check-output">{res.output}</pre>
          {spec.comparison && <Comparison c={spec.comparison} />}
        </>
      ) : (
        <p className="muted small">Not run yet.</p>
      )}
      {spec.next && <p className="small">Then: {spec.next}</p>}
    </section>
  );
}

const num = (n: number) =>
  Math.abs(n) >= 1000 || Number.isInteger(n) ? String(Math.round(n * 100) / 100) : n.toPrecision(4);
const delta = (d: number | null) =>
  d === null ? "n/a" : `${d > 0 ? "+" : ""}${d.toFixed(Math.abs(d) < 10 ? 1 : 0)}%`;

/** A replay's results against the original's: a report, not a verdict. */
function Comparison({ c }: { c: NonNullable<NonNullable<Concept["replay"]>["comparison"]> }) {
  return (
    <div className="comparison">
      <h5 className="small">Compared with the original</h5>
      {c.files.map((f) => (
        <div key={f.replay} className="cmp-file">
          <div className="mono small">
            {f.original === f.replay ? f.replay : `${f.original} → ${f.replay}`}{" "}
            <span className={`muted cmp-${f.status}`}>
              {f.status === "same"
                ? "identical"
                : f.status === "no-original"
                  ? "not in the original"
                  : f.status === "no-replay"
                    ? "not produced"
                    : f.values?.length
                      ? ""
                      : "changed"}
            </span>
          </div>
          {f.values && f.values.length > 0 && (
            <table className="cmp-table small">
              <thead>
                <tr>
                  <th />
                  <th>original</th>
                  <th>replay</th>
                  <th>change</th>
                </tr>
              </thead>
              <tbody>
                {f.values.map((v) => (
                  <tr key={v.name}>
                    <td>{v.name}</td>
                    <td className="mono">{num(v.original)}</td>
                    <td className="mono">{num(v.replay)}</td>
                    <td
                      className={`mono ${v.deltaPct === null || v.deltaPct === 0 ? "" : v.deltaPct > 0 ? "up" : "down"}`}
                    >
                      {delta(v.deltaPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
