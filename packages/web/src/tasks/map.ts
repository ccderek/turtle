import type { Concept } from "@turtle/server/api";

/** Card sizes and gaps of the mind map, in pixels. */
export const MAP = {
  cardW: 236,
  goalH: 92,
  taskH: 86,
  leafH: 40,
  gapX: 56,
  gapY: 12,
  pad: 16,
} as const;

export interface MapNode {
  c: Concept;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** Task children exist (whether shown or collapsed). */
  foldable: boolean;
  parentId: string | null;
}

export interface MapEdge {
  from: string;
  to: string;
  path: string;
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  deps: MapEdge[];
  width: number;
  height: number;
}

/** Concepts drawn as their own node: tasks, lessons and open questions. The rest are counted on the card. */
export function onMap(c: Concept): boolean {
  return c.kind === "task" || c.kind === "lesson" || (c.kind === "question" && !c.answer);
}

/**
 * A horizontal tidy tree for one goal: depth grows to the right, and every subtree gets
 * its own vertical band, so cards never overlap. A parent sits at the middle of its
 * children (or at the top of its band when it is taller than them).
 */
export function layoutGoal(
  goal: Concept,
  kids: Map<string | null, Concept[]>,
  collapsed: ReadonlySet<string>,
): MapLayout {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const heightOf = (c: Concept) =>
    c.kind === "goal" ? MAP.goalH : c.kind === "task" ? MAP.taskH : MAP.leafH;
  const shown = (id: string) => (kids.get(id) ?? []).filter(onMap);
  let maxDepth = 0;

  // Returns the band height used by c's subtree, placing it from `top`.
  const place = (c: Concept, depth: number, top: number, parentId: string | null): MapNode => {
    maxDepth = Math.max(maxDepth, depth);
    const h = heightOf(c);
    const children = shown(c.id);
    const foldable = children.some((k) => k.kind === "task");
    const open = c.kind === "goal" || !collapsed.has(c.id) ? children : [];
    const node: MapNode = {
      c,
      x: MAP.pad + depth * (MAP.cardW + MAP.gapX),
      y: top,
      w: MAP.cardW,
      h,
      depth,
      foldable,
      parentId,
    };
    nodes.push(node);
    let cursor = top;
    const placed: MapNode[] = [];
    for (const k of open) {
      const child = place(k, depth + 1, cursor, c.id);
      placed.push(child);
      cursor = bandBottom.get(child.c.id) ?? cursor;
      cursor += MAP.gapY;
    }
    let bottom = top + h;
    const first = placed[0];
    const last = placed.at(-1);
    if (first && last) {
      const span = cursor - MAP.gapY - top;
      const mid = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
      node.y = Math.max(top, Math.min(mid - h / 2, top + span - h));
      bottom = Math.max(top + span, node.y + h);
    }
    bandBottom.set(c.id, bottom);
    return node;
  };
  const bandBottom = new Map<string, number>();
  place(goal, 0, MAP.pad, null);

  const byId = new Map(nodes.map((n) => [n.c.id, n]));
  for (const n of nodes) {
    const p = n.parentId ? byId.get(n.parentId) : undefined;
    if (p) edges.push({ from: p.c.id, to: n.c.id, path: treePath(p, n) });
  }
  // Dependencies: several arrows on one card fan out instead of overlapping.
  const pairs: [MapNode, MapNode][] = [];
  for (const n of nodes)
    for (const d of n.c.dependsOn ?? []) {
      const from = byId.get(d);
      if (from) pairs.push([from, n]);
    }
  const spread = (
    key: (p: [MapNode, MapNode]) => string,
    other: (p: [MapNode, MapNode]) => MapNode,
  ) => {
    const groups = new Map<string, [MapNode, MapNode][]>();
    for (const p of pairs) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
    const off = new Map<[MapNode, MapNode], number>();
    for (const g of groups.values()) {
      g.sort((x, y) => other(x).y - other(y).y);
      g.forEach((p, i) => {
        off.set(p, (i - (g.length - 1) / 2) * 9);
      });
    }
    return off;
  };
  const outOff = spread(
    (p) => p[0].c.id,
    (p) => p[1],
  );
  const inOff = spread(
    (p) => p[1].c.id,
    (p) => p[0],
  );
  const deps: MapEdge[] = pairs.map((p) => ({
    from: p[0].c.id,
    to: p[1].c.id,
    path: depPath(p[0], p[1], outOff.get(p) ?? 0, inOff.get(p) ?? 0),
  }));

  const height = Math.max(...nodes.map((n) => n.y + n.h)) + MAP.pad;
  const width = MAP.pad * 2 + (maxDepth + 1) * MAP.cardW + maxDepth * MAP.gapX + 40;
  return { nodes, edges, deps, width, height };
}

/** Parent's right edge → child's left edge, with horizontal tangents. */
function treePath(p: MapNode, c: MapNode): string {
  const x1 = p.x + p.w;
  const y1 = p.y + p.h / 2;
  const x2 = c.x;
  const y2 = c.y + c.h / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/**
 * A dependency, from the task that must finish first to the one that waits. In the same
 * column it bows out to the right; otherwise it runs edge to edge.
 */
function depPath(a: MapNode, b: MapNode, off1 = 0, off2 = 0): string {
  if (a.x === b.x) {
    const x = a.x + a.w;
    const y1 = a.y + a.h / 2 + off1;
    const y2 = b.y + b.h / 2 + off2;
    // Longer spans bow further out, so nested arcs do not cross.
    const bow = Math.min(MAP.gapX - 6, 14 + Math.abs(y2 - y1) / 8);
    return `M${x},${y1} C${x + bow},${y1} ${x + bow},${y2} ${x + 2},${y2}`;
  }
  const leftToRight = a.x < b.x;
  const x1 = leftToRight ? a.x + a.w : a.x;
  const x2 = leftToRight ? b.x : b.x + b.w;
  const y1 = a.y + a.h / 2 + off1;
  const y2 = b.y + b.h / 2 + off2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** What a task card counts instead of drawing: findings, decisions, outputs, answered questions. */
export function countsOf(kids: Map<string | null, Concept[]>, id: string): string[] {
  const n = { finding: 0, decision: 0, output: 0, question: 0 };
  for (const k of kids.get(id) ?? []) {
    if (k.kind === "finding" || k.kind === "decision" || k.kind === "output") n[k.kind]++;
    else if (k.kind === "question" && k.answer) n.question++;
  }
  const out: string[] = [];
  const say = (k: number, one: string, many: string) =>
    k && out.push(`${k} ${k === 1 ? one : many}`);
  say(n.finding, "finding", "findings");
  say(n.decision, "decision", "decisions");
  say(n.output, "output", "outputs");
  say(n.question, "answer", "answers");
  return out;
}
