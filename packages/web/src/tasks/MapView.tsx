import { useMemo, useState } from "react";
import type { Concept } from "../api.js";
import { checkVerdict } from "./Checks.js";
import { TASK_STATUS } from "./labels.js";
import { countsOf, layoutGoal, type MapNode } from "./map.js";
import { isHardened } from "./Recipes.js";
import type { GraphCtx } from "./TasksView.js";

interface Props {
  ctx: GraphCtx;
  goal: Concept;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selected: string | null;
  isNew: (c: Concept) => boolean;
  /** Select a task and put the cursor in its "add a subtask" box. */
  onAddUnder: (id: string) => void;
  progressText: string;
}

/**
 * One goal as a mind map (docs/phase2-spec.md §12): a horizontal tidy tree of tasks, with
 * lessons and open questions as small nodes, counts for the rest, and dashed arrows for
 * dependencies (highlighted for the card under the pointer or selected).
 */
export function MapView({
  ctx,
  goal,
  collapsed,
  onToggle,
  selected,
  isNew,
  onAddUnder,
  progressText,
}: Props) {
  const layout = useMemo(() => layoutGoal(goal, ctx.kids, collapsed), [goal, ctx.kids, collapsed]);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;
  const related = (e: { from: string; to: string }) => e.from === focus || e.to === focus;

  return (
    <div className="map-scroll">
      <div className="map-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="map-lines"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker
              id="dep-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" className="dep-head" />
            </marker>
            <marker
              id="dep-arrow-on"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" className="dep-head on" />
            </marker>
          </defs>
          {layout.edges.map((e) => (
            <path key={`${e.from}-${e.to}`} d={e.path} className="tree-edge" />
          ))}
          {layout.deps.map((e) => {
            const on = related(e);
            return (
              <path
                key={`dep-${e.from}-${e.to}`}
                d={e.path}
                className={`dep-edge${on ? " on" : ""}`}
                markerEnd={`url(#${on ? "dep-arrow-on" : "dep-arrow"})`}
              />
            );
          })}
        </svg>
        {layout.nodes.map((n) => (
          <MapCard
            key={n.c.id}
            ctx={ctx}
            n={n}
            selected={selected === n.c.id}
            isNew={isNew(n.c)}
            collapsed={collapsed.has(n.c.id)}
            onToggle={() => onToggle(n.c.id)}
            onAddUnder={() => onAddUnder(n.c.id)}
            onHover={(on) => setHover(on ? n.c.id : null)}
            progressText={progressText}
          />
        ))}
      </div>
    </div>
  );
}

function MapCard({
  ctx,
  n,
  selected,
  isNew,
  collapsed,
  onToggle,
  onAddUnder,
  onHover,
  progressText,
}: {
  ctx: GraphCtx;
  n: MapNode;
  selected: boolean;
  isNew: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onAddUnder: () => void;
  onHover: (on: boolean) => void;
  progressText: string;
}) {
  const { c } = n;
  const style = { left: n.x, top: n.y, width: n.w, height: n.h };
  const hoverProps = {
    onMouseEnter: () => onHover(true),
    onMouseLeave: () => onHover(false),
    onFocus: () => onHover(true),
    onBlur: () => onHover(false),
  };

  if (c.kind === "goal") {
    return (
      <button
        type="button"
        data-cid={c.id}
        className={`map-node map-goal${selected ? " selected" : ""}`}
        style={style}
        onClick={() => ctx.select(c.id)}
      >
        <span className="eyebrow">Goal</span>
        <span className="map-title">{c.title}</span>
        <span className="muted small">{progressText}</span>
      </button>
    );
  }

  if (c.kind !== "task") {
    const lesson = c.kind === "lesson";
    const label = lesson ? "lesson" : c.kind === "check" ? "check" : "asks";
    return (
      <button
        type="button"
        data-cid={c.id}
        className={`map-node map-leaf leaf-${c.kind}${selected ? " selected" : ""}`}
        style={style}
        onClick={() => ctx.select(c.id)}
        title={c.body || c.title}
      >
        <span className={`leaf-kind ${c.kind}`}>{label}</span>
        <span className="map-leaf-text">{c.title}</span>
        {lesson && c.lessonState === "proposed" && <span className="badge ask">proposed</span>}
        {c.kind === "check" && c.checkState === "proposed" && (
          <span className="badge ask">proposed</span>
        )}
        {isNew && <span className="badge new">new</span>}
      </button>
    );
  }

  const st = TASK_STATUS[c.status ?? "todo"] ?? { label: c.status ?? "", tone: "mute" };
  const gone = c.status === "abandoned" || c.status === "dropped";
  const waiting = ctx.graph.waiting?.[c.id];
  const sub = waiting && c.status === "todo" ? waiting : (c.brief ?? "").split("\n")[0];
  const counts = countsOf(ctx.kids, c.id);
  const verdict = checkVerdict(ctx, c);
  const hardened = isHardened(ctx, c.id);
  return (
    <div
      className={`map-node map-task tone-${st.tone}${selected ? " selected" : ""}${gone ? " gone" : ""}`}
      style={style}
      {...hoverProps}
    >
      <button
        type="button"
        data-cid={c.id}
        className="map-task-main"
        onClick={() => ctx.select(c.id)}
        title={c.body || c.title}
      >
        <span className="map-row">
          <span className={`dot ${st.tone}${c.status === "running" ? " pulse-dot" : ""}`} />
          <span className="map-title">{c.title}</span>
        </span>
        <span className="map-row badges">
          <span className={`badge ${st.tone}`}>{st.label}</span>
          {c.role === "planner" && <span className="badge">planner</span>}
          {c.startFrom && (
            <span className="badge mono-badge">from {c.startFrom.checkpointId.slice(0, 6)}</span>
          )}
          {isNew && <span className="badge new">new</span>}
          {c.replay && <span className="badge mono-badge">replay</span>}
          {hardened && (
            <span
              className="badge ok"
              title="A recipe redoes this step; it was verified by a clean replay"
            >
              ⚙ hardened
            </span>
          )}
          {verdict && (
            <span
              className={`badge ${verdict.failed ? "bad" : "ok"}`}
              title="Checks in scope, at the last checkpoint"
            >
              {verdict.failed
                ? `✗ ${verdict.failed} check${verdict.failed > 1 ? "s" : ""}`
                : "✓ checks"}
            </span>
          )}
          {counts.length > 0 && (
            <span className="map-counts muted small">{counts.join(" · ")}</span>
          )}
        </span>
        {sub && <span className="map-sub muted small">{sub}</span>}
      </button>
      {n.foldable && (
        <button
          type="button"
          className="map-fold"
          aria-label={collapsed ? "Expand" : "Collapse"}
          title={collapsed ? "Show subtasks" : "Hide subtasks"}
          onClick={onToggle}
        >
          {collapsed ? "+" : "−"}
        </button>
      )}
      {!gone && (
        <button
          type="button"
          className="map-add"
          aria-label={`Add a subtask to ${c.title}`}
          title="Add a subtask"
          onClick={onAddUnder}
        >
          ＋
        </button>
      )}
    </div>
  );
}
