import type { BranchView, NodeView } from "@turtle/server/api";

export interface Row {
  node: NodeView;
  lane: number;
  /** Row index, 0 = top (newest). */
  index: number;
}

export interface Edge {
  /** Child row (upper) and parent row (lower). */
  from: { row: number; lane: number };
  to: { row: number; lane: number };
  fork: boolean;
}

export interface TreeLayout {
  rows: Row[];
  edges: Edge[];
  lanes: number;
}

/**
 * Git-graph style layout: one row per node, newest first; one lane (column) per branch.
 * Lanes are reused once a branch's rows end, unless it may still grow (running/idle).
 */
export function layoutTree(nodes: NodeView[], branches: BranchView[]): TreeLayout {
  const ordered = topoByTime(nodes);
  const n = ordered.length;
  // Ascending position (0 = oldest); display row = n - 1 - pos.
  const pos = new Map(ordered.map((node, i) => [node.id, i]));
  const branchStatus = new Map(branches.map((b) => [b.id, b.status]));

  const spans = new Map<string, { start: number; end: number }>();
  for (const node of ordered) {
    const p = pos.get(node.id) ?? 0;
    const parentPos = node.displayParent !== null ? pos.get(node.displayParent) : undefined;
    const span = spans.get(node.branchId);
    if (!span) {
      // The lane is reserved from the fork point so the fork curve has room.
      const forkedHere =
        parentPos !== undefined && nodeBranch(ordered, parentPos) !== node.branchId;
      spans.set(node.branchId, { start: forkedHere ? parentPos + 1 : p, end: p });
    } else span.end = p;
  }
  for (const [branchId, span] of spans) {
    const st = branchStatus.get(branchId);
    if (st === "running" || st === "idle") span.end = n;
  }

  const laneOf = new Map<string, number>();
  const laneEnds: number[] = [];
  const bySpan = [...spans.entries()].sort(
    (a, b) => a[1].start - b[1].start || a[1].end - b[1].end,
  );
  for (const [branchId, span] of bySpan) {
    let lane = laneEnds.findIndex((end) => end < span.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.end;
    laneOf.set(branchId, lane);
  }

  const rows: Row[] = ordered
    .map((node, i) => ({ node, lane: laneOf.get(node.branchId) ?? 0, index: n - 1 - i }))
    .reverse();
  const rowById = new Map(rows.map((r) => [r.node.id, r]));
  const edges: Edge[] = [];
  for (const r of rows) {
    const parent = r.node.displayParent ? rowById.get(r.node.displayParent) : undefined;
    if (!parent) continue;
    edges.push({
      from: { row: r.index, lane: r.lane },
      to: { row: parent.index, lane: parent.lane },
      fork: parent.lane !== r.lane,
    });
  }
  return { rows, edges, lanes: Math.max(1, laneEnds.length) };
}

function nodeBranch(ordered: NodeView[], p: number): string | undefined {
  return ordered[p]?.branchId;
}

/** Oldest first, parents always before children (timestamps can tie or skew). */
export function topoByTime(nodes: NodeView[]): NodeView[] {
  const byTime = [...nodes].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, NodeView[]>();
  const waiting = new Map<string, number>();
  for (const n of byTime) {
    const p = n.displayParent && ids.has(n.displayParent) ? n.displayParent : null;
    waiting.set(n.id, p ? 1 : 0);
    if (p) children.set(p, [...(children.get(p) ?? []), n]);
  }
  const rank = new Map(byTime.map((n, i) => [n.id, i]));
  const ready = byTime.filter((n) => waiting.get(n.id) === 0);
  const out: NodeView[] = [];
  while (ready.length) {
    ready.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const next = ready.shift() as NodeView;
    out.push(next);
    for (const c of children.get(next.id) ?? []) {
      const w = (waiting.get(c.id) ?? 1) - 1;
      waiting.set(c.id, w);
      if (w === 0) ready.push(c);
    }
  }
  return out;
}
