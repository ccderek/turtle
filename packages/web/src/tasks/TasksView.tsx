import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "../App.js";
import {
  type ActivityItem,
  type Concept,
  type GraphResponse,
  get,
  post,
  type StateResponse,
} from "../api.js";
import { ago } from "../format.js";
import { ConceptPanel } from "./ConceptPanel.js";
import { KIND_LABEL, TASK_STATUS } from "./labels.js";
import { MapView } from "./MapView.js";
import { buildRows, childrenMap, evidenceCount, progress } from "./tree.js";

export interface GraphCtx {
  graph: GraphResponse;
  byId: Map<string, Concept>;
  kids: Map<string | null, Concept[]>;
  version: number;
  select: (id: string | null) => void;
  refresh: () => void;
  toast: (text: string, tone?: "info" | "ok" | "warn" | "bad") => void;
  short: (id: string) => string;
  /** Show a checkpoint or branch in the Code tab. */
  openCode: (sel: Selection) => void;
  /** The primary source's runs (branches, agents, checkpoints): the task panel's code tabs. */
  code: StateResponse;
  codeShort: (id: string) => string;
  /** A task whose "add a subtask" box should take the cursor (the map's ＋). */
  addUnder: string | null;
  setAddUnder: (id: string | null) => void;
}

interface Props {
  version: number;
  toast: GraphCtx["toast"];
  selected: string | null;
  onSelect: (id: string | null) => void;
  openCode: (sel: Selection) => void;
  code: StateResponse;
  codeShort: (id: string) => string;
}

type Layout = "map" | "outline";
const LAYOUT_KEY = "turtle.tasksLayout";
function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "outline" ? "outline" : "map";
  } catch {
    return "map";
  }
}

/** Phones get the outline: a mind map needs width. */
function useNarrow(): boolean {
  const q = "(max-width: 720px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** The task graph: goals as mind maps, with what needs you and what agents did (Phase 2). */
export function TasksView({
  version,
  toast,
  openCode,
  selected,
  onSelect,
  code,
  codeShort,
}: Props) {
  const [layoutPref, setLayoutPref] = useState<Layout>(readLayout);
  const narrow = useNarrow();
  const layout: Layout = narrow ? "outline" : layoutPref;
  const [addUnder, setAddUnder] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showDropped, setShowDropped] = useState(false);
  const [newGoal, setNewGoal] = useState(false);
  const [seenAt, setSeenAt] = useState<string>(() => readSeen());
  const inflight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const [g, a] = await Promise.all([
          get<GraphResponse>("/api/graph"),
          get<ActivityItem[]>("/api/activity?limit=40"),
        ]);
        setGraph(g);
        setActivity(a);
        setError(null);
      } while (again.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inflight.current = false;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    void refresh();
  }, [version, refresh]);

  const byId = useMemo(() => new Map((graph?.concepts ?? []).map((c) => [c.id, c])), [graph]);
  // Bring the selected concept into view once it is on the page (a new goal lands at the end).
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledTo.current === selected || !byId.has(selected)) return;
    const el = document.querySelector(`[data-cid="${selected}"]`);
    if (!el) return;
    scrolledTo.current = selected;
    el.scrollIntoView({ block: "nearest" });
  }, [selected, byId]);
  const kids = useMemo(() => childrenMap(graph?.concepts ?? [], showDropped), [graph, showDropped]);
  const short = useCallback((id: string) => id.replace(/^c_/, "").slice(0, 4), []);
  const goals = kids.get(null)?.filter((c) => c.kind === "goal") ?? [];

  if (!graph)
    return (
      <div className="pad muted">{error ? `Cannot load the task graph: ${error}` : "Loading…"}</div>
    );

  const ctx: GraphCtx = {
    graph,
    byId,
    kids,
    version,
    select: onSelect,
    refresh: () => void refresh(),
    toast,
    short,
    openCode,
    code,
    codeShort,
    addUnder,
    setAddUnder,
  };
  const toggleFold = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const isNew = (c: Concept) => c.createdBy.type === "agent" && c.createdAt > seenAt;
  const pickLayout = (l: Layout) => {
    setLayoutPref(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {}
  };
  const running = new Set(graph.running ?? []);

  // Needs you: open questions, blocked or failed tasks, lessons to confirm.
  const needs = graph.concepts
    .filter((c) => !c.dropped)
    .filter(
      (c) =>
        (c.kind === "question" &&
          !c.answer &&
          byId.get(c.parentId ?? "")?.status !== "abandoned") ||
        (c.kind === "task" && (c.status === "blocked" || c.status === "failed")) ||
        (c.kind === "lesson" && c.lessonState === "proposed") ||
        (c.kind === "check" && c.checkState === "proposed"),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unseen = activity.filter((a) => a.byAgent && a.at > seenAt).length;

  const toggleAuto = async () => {
    try {
      await post("/api/scheduler", { autoStart: !graph.autoStart });
      void refresh();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  return (
    <div className={`tasks-layout${selected ? " with-panel" : ""}`}>
      <nav className="tasks-side" aria-label="Needs you and activity">
        <section>
          <h3>
            Needs you <span className="count">{needs.length}</span>
          </h3>
          {needs.length === 0 && <p className="muted small pad-x">Nothing is waiting for you.</p>}
          {needs.map((c) => (
            <button key={c.id} type="button" className="need-card" onClick={() => onSelect(c.id)}>
              <span className="need-kind">
                {c.kind === "question"
                  ? "Question"
                  : c.kind === "lesson"
                    ? "Lesson to confirm"
                    : c.kind === "check"
                      ? "Check to activate"
                      : TASK_STATUS[c.status ?? ""]?.label}
              </span>
              <span className="title">{c.title}</span>
              <span className="muted small">{byId.get(c.parentId ?? "")?.title ?? ""}</span>
            </button>
          ))}
        </section>
        <section>
          <h3>
            Activity {unseen > 0 && <span className="count new">{unseen} new</span>}
            {unseen > 0 && (
              <button
                type="button"
                className="link small"
                onClick={() => {
                  const now = new Date().toISOString();
                  setSeenAt(now);
                  writeSeen(now);
                }}
              >
                mark seen
              </button>
            )}
          </h3>
          <p className="muted small pad-x">
            Agents add tasks and findings on their own; this only informs you.
          </p>
          <ul className="activity">
            {activity.map((a) => (
              <li key={a.id} className={a.byAgent && a.at > seenAt ? "fresh" : ""}>
                <button
                  type="button"
                  className="link-row"
                  onClick={() => a.conceptId && onSelect(a.conceptId)}
                >
                  <span className="act-who">{a.who}</span> {a.text}
                  <span className="muted small"> · {ago(a.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </nav>

      <main className="tasks-main">
        <div className="tasks-toolbar">
          <button type="button" className="primary" onClick={() => setNewGoal(true)}>
            New goal
          </button>
          <label
            className="toggle"
            title="Start tasks whose dependencies are done, up to the parallel cap"
          >
            <input type="checkbox" checked={graph.autoStart ?? false} onChange={toggleAuto} />
            Auto-start ready tasks{" "}
            <span className="muted small">
              ({running.size}/{graph.maxParallel ?? 0} running)
            </span>
          </label>
          {!narrow && (
            <fieldset className="seg" aria-label="Layout">
              {(["map", "outline"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={layout === l}
                  className={layout === l ? "on" : ""}
                  onClick={() => pickLayout(l)}
                >
                  {l === "map" ? "Map" : "Outline"}
                </button>
              ))}
            </fieldset>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={showDropped}
              onChange={(e) => setShowDropped(e.target.checked)}
            />
            Show dropped
          </label>
        </div>
        {goals.length === 0 && (
          <div className="empty">
            <h2>No goals yet</h2>
            <p>
              Write what you want to get done. A planner agent splits it into tasks, and you can add
              your own.
            </p>
            <button type="button" className="primary" onClick={() => setNewGoal(true)}>
              New goal
            </button>
          </div>
        )}
        {goals.map((g) => {
          const p = progress(kids, g.id);
          const progressText = `${p.done}/${p.total} tasks done${p.running ? ` · ${p.running} running` : ""}`;
          if (layout === "map")
            return (
              <section key={g.id} className="goal-block">
                <MapView
                  ctx={ctx}
                  goal={g}
                  collapsed={collapsed}
                  onToggle={toggleFold}
                  selected={selected}
                  isNew={isNew}
                  onAddUnder={(id) => {
                    setAddUnder(id);
                    onSelect(id);
                  }}
                  progressText={progressText}
                />
              </section>
            );
          const rows = buildRows(kids, g.id, collapsed);
          return (
            <section key={g.id} className="goal-block">
              <button
                type="button"
                data-cid={g.id}
                className={`goal-card${selected === g.id ? " selected" : ""}`}
                onClick={() => onSelect(g.id)}
              >
                <span className="eyebrow">Goal</span>
                <span className="goal-title">{g.title}</span>
                <span className="muted small">{progressText}</span>
              </button>
              <ul className="outline">
                {rows.map((r) => (
                  <OutlineRow
                    key={r.c.id}
                    ctx={ctx}
                    c={r.c}
                    depth={r.depth}
                    hasChildren={r.hasChildren}
                    collapsed={collapsed.has(r.c.id)}
                    isNew={isNew(r.c)}
                    selected={selected === r.c.id}
                    onToggle={() => toggleFold(r.c.id)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </main>

      {selected && byId.get(selected) && (
        <aside className="panel tasks-panel">
          <ConceptPanel key={selected} ctx={ctx} id={selected} onClose={() => onSelect(null)} />
        </aside>
      )}
      {newGoal && <NewGoalDialog ctx={ctx} onClose={() => setNewGoal(false)} />}
    </div>
  );
}

function OutlineRow({
  ctx,
  c,
  depth,
  hasChildren,
  collapsed,
  isNew,
  selected,
  onToggle,
}: {
  ctx: GraphCtx;
  c: Concept;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  isNew: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const guides = Array.from({ length: depth }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional.
    <span key={i} className={`guide${i === depth - 1 ? " elbow" : ""}`} aria-hidden="true" />
  ));
  const st = TASK_STATUS[c.status ?? "todo"] ?? { label: c.status ?? "", tone: "mute" };
  const waiting = ctx.graph.waiting?.[c.id];
  if (c.kind === "task") {
    const gone = c.status === "abandoned" || c.status === "dropped";
    const by = c.createdBy.type === "agent" ? "agent" : "you";
    return (
      <li className="outline-row">
        {guides}
        {hasChildren ? (
          <button
            type="button"
            className="fold"
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={onToggle}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="fold" />
        )}
        <button
          type="button"
          data-cid={c.id}
          className={`task-card${selected ? " selected" : ""}${gone ? " gone" : ""}`}
          onClick={() => ctx.select(c.id)}
        >
          <span className="row1">
            <span className={`dot ${st.tone}${c.status === "running" ? " pulse-dot" : ""}`} />
            <span className="title">{c.title}</span>
            <span className={`badge ${st.tone}`}>{st.label}</span>
            {c.role === "planner" && <span className="badge">planner</span>}
            {c.startFrom && (
              <span className="badge mono-badge">from {c.startFrom.checkpointId.slice(0, 6)}</span>
            )}
            <span className="badge">by {by}</span>
            {isNew && <span className="badge new">new</span>}
          </span>
          {(c.brief || waiting) && (
            <span className="sub muted small">
              {waiting && c.status === "todo" ? waiting : (c.brief ?? "").split("\n")[0]}
            </span>
          )}
        </button>
      </li>
    );
  }
  const claimed = c.kind === "finding" && evidenceCount(ctx.graph.links, c.id) === 0;
  const lessonState = c.kind === "lesson" ? c.lessonState : null;
  return (
    <li className="outline-row">
      {guides}
      <span className="fold" />
      <button
        type="button"
        data-cid={c.id}
        className={`leaf leaf-${c.kind}${selected ? " selected" : ""}`}
        onClick={() => ctx.select(c.id)}
      >
        <span className={`leaf-kind ${c.kind}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
        <span className="leaf-text">
          {c.kind === "output" ? (c.path ?? c.title) : c.title}
          {c.kind === "question" && c.answer && <span className="muted"> → {c.answer.text}</span>}
        </span>
        {claimed && <span className="badge mute">claimed</span>}
        {lessonState && lessonState !== "confirmed" && (
          <span className="badge ask">{lessonState}</span>
        )}
        {c.kind === "check" && c.checkState !== "active" && (
          <span className={`badge ${c.checkState === "proposed" ? "ask" : "mute"}`}>
            {c.checkState}
          </span>
        )}
        {c.kind === "question" && !c.answer && <span className="badge ask">open</span>}
        {isNew && <span className="badge new">new</span>}
      </button>
    </li>
  );
}

function NewGoalDialog({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [plan, setPlan] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const r = await post<{ goal: Concept }>("/api/goals", { title, body, plan });
      ctx.toast(
        plan ? "Goal added; a planner agent is splitting it into tasks" : "Goal added",
        "ok",
      );
      ctx.refresh();
      ctx.select(r.goal.id);
      onClose();
    } catch (err) {
      ctx.toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="new-goal-title">
      <div className="dialog-head">
        <h2 id="new-goal-title">New goal</h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          What do you want to get done?
          <input
            id="goal-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Build a trading system that trades every 8 hours"
          />
        </label>
        <label className="field">
          Details <span className="muted small">(optional)</span>
          <textarea
            id="goal-body"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What you already know, constraints, what done looks like"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
          Let a planner agent split it into tasks
        </label>
        <div className="composer-actions">
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? "Adding…" : "Add goal"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function readSeen(): string {
  try {
    return window.localStorage.getItem("turtle.seenAt") ?? new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function writeSeen(v: string): void {
  try {
    window.localStorage.setItem("turtle.seenAt", v);
  } catch {}
}
