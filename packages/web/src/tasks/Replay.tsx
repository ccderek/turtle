import { useEffect, useMemo, useRef, useState } from "react";
import { type Concept, post } from "../api.js";
import type { GraphCtx } from "./TasksView.js";

interface PlanStep {
  nodeId: string;
  summary: string;
  mode: "apply" | "recipe" | "redo";
  paths: string[];
  status?: string;
  note?: string;
}
interface Plan {
  source: { taskId: string; nodeId: string };
  steps: PlanStep[];
  params: Record<string, string>;
  recipe: { id: string; title: string } | null;
  outputs: string[];
}

interface ChainLink {
  taskId: string;
  title: string;
  why: string | null;
  upstream: string[];
  startsAfter: string | null;
  steps: PlanStep[];
  params: Record<string, string>;
  recipe: { id: string; title: string } | null;
}

const MODE_LABEL: Record<PlanStep["mode"], string> = {
  apply: "apply the code change",
  recipe: "rerun the results with the recipe",
  redo: "an agent regenerates the results",
};

const firstLine = (s: string) => s.split("\n")[0] ?? "";

/**
 * Replay a task's steps onto a new base (architecture §3.7): your repository now (the code
 * changed), the same start (only parameters change), or another task's checkpoint.
 */
export function ReplayDialog({
  ctx,
  c,
  onClose,
}: {
  ctx: GraphCtx;
  c: Concept;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const branchIds = new Set((c.branches ?? []).map((b) => b.branch));
  const checkpoints = ctx.code.nodes
    .filter((n) => branchIds.has(n.branchId) && n.kind === "semantic")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [nodeId, setNodeId] = useState(checkpoints[0]?.id ?? "");
  const [onto, setOnto] = useState<"repo" | "start" | "task">("repo");
  const [ontoTask, setOntoTask] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPlan(null);
    post<Plan>("/api/replays/plan", { taskId: c.id, ...(nodeId ? { nodeId } : {}) }).then(
      (p) => {
        setPlan(p);
        setParams(p.params);
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  }, [c.id, nodeId]);
  const hasUpstream = (c.dependsOn ?? []).length > 0 || !!c.startFrom;
  const [chain, setChain] = useState<ChainLink[]>([]);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [upParams, setUpParams] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    if (!hasUpstream) return;
    post<ChainLink[]>("/api/replays/chain/plan", {
      taskId: c.id,
      ...(nodeId ? { nodeId } : {}),
    }).then(
      (links) => {
        const up = links.filter((l) => l.taskId !== c.id);
        setChain(up);
        setUpParams(Object.fromEntries(up.map((l) => [l.taskId, l.params])));
      },
      () => setChain([]),
    );
  }, [c.id, nodeId, hasUpstream]);
  const chained = include.size > 0;
  const toggle = (id: string, on: boolean) =>
    setInclude((cur) => {
      const n = new Set(cur);
      // A task's own upstream tasks come with it: replaying it on stale inputs would mislead.
      const closure = (x: string, acc: Set<string>) => {
        acc.add(x);
        for (const u of chain.find((l) => l.taskId === x)?.upstream ?? [])
          if (chain.some((l) => l.taskId === u && !l.why)) closure(u, acc);
        return acc;
      };
      if (on) for (const x of closure(id, new Set())) n.add(x);
      else {
        n.delete(id);
        // Downstream tasks that need it go too.
        for (const l of chain)
          if (n.has(l.taskId) && closure(l.taskId, new Set()).has(id)) n.delete(l.taskId);
      }
      return n;
    });
  const others = useMemo(
    () =>
      ctx.graph.concepts.filter(
        (t) =>
          t.kind === "task" &&
          t.id !== c.id &&
          !t.dropped &&
          ctx.graph.links.some(
            (l) => l.from === t.id && l.rel === "evidence" && l.to.type === "node",
          ),
      ),
    [ctx.graph, c.id],
  );
  const noModel = plan ? plan.steps.every((s) => s.mode !== "redo") : false;
  return (
    <dialog
      ref={ref}
      className="dialog replay-dialog"
      onClose={onClose}
      aria-labelledby="replay-title"
    >
      <div className="dialog-head">
        <h2 id="replay-title">Replay “{c.title}”</h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (chained) {
              const made = await post<Concept[]>("/api/replays/chain", {
                taskId: c.id,
                nodeId,
                onto: onto === "start" ? "start" : "repo",
                include: [...include, c.id],
                params: {
                  ...Object.fromEntries([...include].map((id) => [id, upParams[id] ?? {}])),
                  [c.id]: params,
                },
                next,
              });
              ctx.toast(
                `Chain replay added: ${made.length} tasks, each starts when the one before is done`,
                "ok",
              );
              ctx.refresh();
              onClose();
              const last = made.at(-1);
              if (last) ctx.select(last.id);
              return;
            }
            const t = await post<Concept>("/api/replays", {
              taskId: c.id,
              nodeId,
              onto: onto === "task" ? "checkpoint" : onto,
              ...(onto === "task" ? { ontoTask } : {}),
              params,
              next,
            });
            ctx.toast("Replay added: code changes are applied and results rerun", "ok");
            ctx.refresh();
            onClose();
            ctx.select(t.id);
          } catch (e2) {
            ctx.toast((e2 as Error).message, "bad");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small">
          Redo this task's steps somewhere else. Code changes are applied as they were; results are
          rerun, never copied. A step that no longer applies goes to an agent, with only what is
          left.
        </p>
        <label className="field">
          Steps up to
          <select
            id={`replay-node-${c.id}`}
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
          >
            {checkpoints.map((n) => (
              <option key={n.id} value={n.id}>
                {ctx.codeShort(n.id)} · {firstLine(n.summary ?? n.kind)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="effort-list">
          <legend>Onto</legend>
          <label className="check">
            <input
              type="radio"
              name="onto"
              checked={onto === "repo"}
              onChange={() => setOnto("repo")}
            />
            Your repository as it is now (the code changed since)
          </label>
          <label className="check">
            <input
              type="radio"
              name="onto"
              checked={onto === "start"}
              onChange={() => setOnto("start")}
            />
            The same start as before (only parameters change)
          </label>
          <label className="check">
            <input
              type="radio"
              name="onto"
              checked={onto === "task"}
              onChange={() => setOnto("task")}
              disabled={!others.length || chained}
            />
            The latest checkpoint of another task
          </label>
          {onto === "task" && (
            <select
              id={`replay-onto-${c.id}`}
              value={ontoTask}
              onChange={(e) => setOntoTask(e.target.value)}
            >
              <option value="" disabled>
                Choose a task…
              </option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
        </fieldset>
        {chain.length > 0 && (
          <fieldset className="effort-list chain-list">
            <legend>Upstream tasks</legend>
            <p className="muted small">
              Replay them first, in order, each when the one before is done. A task that started
              from one of them starts from its replay, on the new results. Unchecked tasks are kept
              as they are.
            </p>
            {chain.map((l) => (
              <div key={l.taskId} className="chain-item">
                <label className="check">
                  <input
                    type="checkbox"
                    id={`replay-up-${l.taskId}`}
                    checked={include.has(l.taskId)}
                    disabled={!!l.why}
                    onChange={(e) => toggle(l.taskId, e.target.checked)}
                  />
                  {l.title}{" "}
                  <span className="muted small">
                    {l.why
                      ? `(cannot be replayed: ${l.why})`
                      : `(${l.steps.length} step(s)${l.steps.some((s) => s.mode === "redo") ? ", needs an agent for its results" : ""})`}
                  </span>
                </label>
                {include.has(l.taskId) &&
                  Object.keys(l.params).map((k) => (
                    <label key={k} className="field inline-field">
                      <span className="mono">{k}</span>
                      <input
                        id={`replay-up-${l.taskId}-${k}`}
                        className="mono"
                        value={upParams[l.taskId]?.[k] ?? ""}
                        onChange={(e) =>
                          setUpParams((p) => ({
                            ...p,
                            [l.taskId]: { ...(p[l.taskId] ?? {}), [k]: e.target.value },
                          }))
                        }
                      />
                    </label>
                  ))}
              </div>
            ))}
          </fieldset>
        )}
        {err && <p className="bad small">{err}</p>}
        {plan && (
          <>
            {Object.keys(plan.params).length > 0 && (
              <fieldset className="effort-list">
                <legend>Parameters (recipe “{plan.recipe?.title}”)</legend>
                {Object.keys(plan.params).map((k) => (
                  <label key={k} className="field inline-field">
                    <span className="mono">{k}</span>
                    <input
                      id={`replay-param-${k}`}
                      className="mono"
                      value={params[k] ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))}
                    />
                  </label>
                ))}
              </fieldset>
            )}
            <div>
              <h4 className="small">
                {plan.steps.length} step(s){noModel ? " — no model needed if they apply" : ""}
              </h4>
              <ol className="replay-steps">
                {plan.steps.map((s) => (
                  <li key={s.nodeId}>
                    <span className={`badge mode-${s.mode}`}>{MODE_LABEL[s.mode]}</span>{" "}
                    {firstLine(s.summary)}
                    <div className="muted small mono">{s.paths.join(", ")}</div>
                  </li>
                ))}
              </ol>
              {!plan.recipe && plan.outputs.length > 0 && (
                <p className="muted small">
                  Tip: a verified recipe on this task would rerun its results without a model.
                </p>
              )}
            </div>
          </>
        )}
        <label className="field">
          Then <span className="muted small">(optional: what an agent does after the replay)</span>
          <textarea
            id={`replay-next-${c.id}`}
            rows={2}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="e.g. compare the results with the original and write a finding"
          />
        </label>
        <div className="composer-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !plan || (onto === "task" && !ontoTask && !chained)}
          >
            {chained ? `Replay ${include.size + 1} tasks` : "Replay"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** On a path replay task: each step and what happened to it. */
export function PathReplaySteps({ c }: { c: Concept }) {
  const steps = c.replay?.steps ?? [];
  if (!c.replay?.source || !steps.length) return null;
  const mark: Record<string, string> = {
    applied: "✓",
    done: "✓",
    failed: "✗",
    handed: "→ agent",
    pending: "·",
  };
  return (
    <ol className="replay-steps">
      {steps.map((s) => (
        <li key={s.nodeId} className={`step-${s.status ?? "pending"}`}>
          <span className="mono">{mark[s.status ?? "pending"]}</span> {firstLine(s.summary)}{" "}
          <span className="muted small">({MODE_LABEL[s.mode]})</span>
        </li>
      ))}
    </ol>
  );
}

/** On a replay that is part of a chain: the chain, in order. */
export function ChainInfo({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const id = c.replay?.chain;
  if (!id) return null;
  const members = ctx.graph.concepts
    .filter((t) => t.kind === "task" && t.replay?.chain === id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <p className="small chain-info">
      Chain replay:{" "}
      {members.map((m, i) => (
        <span key={m.id}>
          {i > 0 && " → "}
          {m.id === c.id ? (
            <strong>{m.title}</strong>
          ) : (
            <button type="button" className="link" onClick={() => ctx.select(m.id)}>
              {m.title}
            </button>
          )}{" "}
          <span className="muted">({m.status ?? "todo"})</span>
        </span>
      ))}
    </p>
  );
}
