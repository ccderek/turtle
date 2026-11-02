import { useMemo } from "react";
import type { Ctx, Selection } from "./App.js";
import type { BranchView, NodeView } from "./api.js";
import { ago, firstLine, money, STATUS_LABEL, statusTone } from "./format.js";
import { layoutTree } from "./layout.js";

const ROW_H = 34;
const LANE_W = 18;
const PAD = 14;

interface Props {
  ctx: Ctx;
  selection: Selection | null;
  showSteps: boolean;
  onNewRun: () => void;
}

export function TreeView({ ctx, selection, showSteps, onNewRun }: Props) {
  const { state, short, select } = ctx;
  const layout = useMemo(
    () => layoutTree(state.nodes, state.branches),
    [state.nodes, state.branches],
  );
  const chips = useMemo(() => {
    const m = new Map<string, BranchView[]>();
    for (const b of state.branches) {
      const at = showSteps ? b.headNodeId : b.checkpointHeadId;
      if (at) m.set(at, [...(m.get(at) ?? []), b]);
    }
    return m;
  }, [state.branches, showSteps]);
  const runningHeads = useMemo(
    () =>
      new Set(
        state.branches
          .filter((b) => b.status === "running")
          .map((b) => (showSteps ? b.headNodeId : b.checkpointHeadId)),
      ),
    [state.branches, showSteps],
  );
  const snapshots = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of state.snapshots) m.set(s.nodeId, [...(m.get(s.nodeId) ?? []), s.name]);
    return m;
  }, [state.snapshots]);

  if (!state.nodes.length) {
    return (
      <div className="empty">
        <h2>No runs yet</h2>
        <p>
          Start an agent on <b>{state.repo.name}</b>. Each checkpoint it makes appears here as a
          node; forks become new lanes.
        </p>
        <button type="button" className="primary" onClick={onNewRun}>
          New run
        </button>
        <p className="muted small">
          or in a terminal: <code>turtle run "&lt;task&gt;"</code>
        </p>
      </div>
    );
  }

  const graphW = PAD * 2 + (layout.lanes - 1) * LANE_W;
  const height = layout.rows.length * ROW_H;
  const x = (lane: number) => PAD + lane * LANE_W;
  const y = (row: number) => row * ROW_H + ROW_H / 2;
  const selectedNode = selection?.type === "node" ? selection.id : null;
  const selectedBranch = selection?.type === "branch" ? selection.id : null;

  return (
    <div className="tree" style={{ height }}>
      <svg className="graph" width={graphW} height={height} aria-hidden="true">
        {layout.edges.map((e) => {
          const x1 = x(e.from.lane);
          const y1 = y(e.from.row);
          const x2 = x(e.to.lane);
          const y2 = y(e.to.row);
          const d = e.fork
            ? `M${x1},${y1} L${x1},${y2 - ROW_H * 0.6} Q${x1},${y2} ${x2},${y2}`
            : `M${x1},${y1} L${x2},${y2}`;
          return (
            <path
              key={`${e.from.row}-${e.to.row}`}
              d={d}
              className={`edge lane-${e.from.lane % 6}`}
            />
          );
        })}
        {layout.rows.map((r) => (
          <NodeMark
            key={r.node.id}
            node={r.node}
            cx={x(r.lane)}
            cy={y(r.index)}
            running={runningHeads.has(r.node.id)}
            selected={selectedNode === r.node.id}
          />
        ))}
      </svg>
      <ul className="rows" aria-label="Checkpoint tree">
        {layout.rows.map((r) => {
          const n = r.node;
          const branchChips = chips.get(n.id) ?? [];
          return (
            <li
              key={n.id}
              className={`row kind-${n.kind}${selectedNode === n.id ? " selected" : ""}`}
              style={{ top: r.index * ROW_H, height: ROW_H, paddingLeft: graphW + 4 }}
              onClick={() => select({ type: "node", id: n.id })}
              onKeyDown={(e) => {
                if (e.key === "Enter") select({ type: "node", id: n.id });
              }}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a row holds branch buttons, so it cannot itself be a button.
              tabIndex={0}
            >
              <span className="id mono">{short(n.id)}</span>
              <span className="summary" title={n.summary ?? ""}>
                {n.kind === "root"
                  ? rootLabel(n)
                  : firstLine(n.summary) || <i className="muted">(no summary)</i>}
              </span>
              {n.hiddenSteps > 0 && (
                <span className="steps muted">
                  {n.hiddenSteps} {n.hiddenSteps === 1 ? "step" : "steps"}
                </span>
              )}
              {(n.status === "need_decision" ||
                n.status === "blocked" ||
                n.status === "failed" ||
                n.status === "killed") && (
                <span className={`badge ${statusTone(n.status)}`}>{STATUS_LABEL[n.status]}</span>
              )}
              {(snapshots.get(n.id) ?? []).map((s) => (
                <span key={s} className="badge snap" title="snapshot">
                  ⚑ {s}
                </span>
              ))}
              {branchChips.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className={`chip ${statusTone(b.status)}${selectedBranch === b.id ? " selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ type: "branch", id: b.id });
                  }}
                  title={`branch ${b.id} · ${STATUS_LABEL[b.status] ?? b.status}`}
                >
                  {b.name ?? short(b.id)} · {STATUS_LABEL[b.status] ?? b.status}
                  {b.status === "running" && !showSteps && b.pendingSteps > 0
                    ? ` · +${b.pendingSteps}`
                    : ""}
                </button>
              ))}
              <span className="meta">
                {n.tests && n.tests !== "none" && (
                  <span className={n.tests === "pass" ? "ok" : "bad"} title={`tests ${n.tests}`}>
                    {n.tests === "pass" ? "✓ tests" : "✗ tests"}
                  </span>
                )}
                {n.kind !== "root" && (n.linesAdded || n.linesDeleted) ? (
                  <span className="lines">
                    <span className="add">+{n.linesAdded ?? 0}</span>{" "}
                    <span className="del">−{n.linesDeleted ?? 0}</span>
                  </span>
                ) : null}
                {n.costUsdEst > 0 && <span className="cost">{money(n.costUsdEst)}</span>}
                <span className="time">{ago(n.createdAt)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function rootLabel(n: NodeView): string {
  return (n.summary ?? "root").replace(/^root: /, "start · ");
}

function NodeMark({
  node,
  cx,
  cy,
  running,
  selected,
}: {
  node: NodeView;
  cx: number;
  cy: number;
  running: boolean;
  selected: boolean;
}) {
  const tone = statusTone(node.status);
  const ring = selected ? <circle cx={cx} cy={cy} r={9} className="sel-ring" /> : null;
  const pulse = running ? <circle cx={cx} cy={cy} r={7} className="pulse" /> : null;
  let mark: React.ReactNode;
  if (node.kind === "root") {
    mark = <rect x={cx - 5} y={cy - 5} width={10} height={10} rx={2} className="mark root" />;
  } else if (node.kind === "micro") {
    mark = <circle cx={cx} cy={cy} r={2.5} className="mark micro" />;
  } else if (node.kind === "human_edit") {
    mark = (
      <path
        d={`M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} Z`}
        className={`mark fill ${tone}`}
      />
    );
  } else {
    const auto = node.summarySource === "rule_auto";
    mark = (
      <circle cx={cx} cy={cy} r={5.5} className={`mark ${auto ? "hollow" : "fill"} ${tone}`} />
    );
  }
  return (
    <g>
      {pulse}
      {ring}
      {mark}
    </g>
  );
}
