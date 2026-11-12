import type { Concept, Link } from "@turtle/server/api";

export interface Row {
  c: Concept;
  depth: number;
  hasChildren: boolean;
}

const ORDER: Record<string, number> = {
  question: 0,
  lesson: 1,
  check: 2,
  decision: 3,
  finding: 4,
  output: 5,
  task: 6,
  goal: 7,
};

/** Children of each concept, in display order (dropped ones only when asked). */
export function childrenMap(
  concepts: Concept[],
  showDropped = false,
): Map<string | null, Concept[]> {
  const m = new Map<string | null, Concept[]>();
  for (const c of concepts) {
    if (c.dropped && !showDropped) continue;
    m.set(c.parentId, [...(m.get(c.parentId) ?? []), c]);
  }
  for (const list of m.values()) {
    list.sort(
      (a, b) =>
        (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) ||
        (a.order ?? "").localeCompare(b.order ?? "") ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }
  return m;
}

/** The outline under one goal, depth-first; collapsed nodes hide their subtree. */
export function buildRows(
  kids: Map<string | null, Concept[]>,
  goalId: string,
  collapsed: ReadonlySet<string>,
): Row[] {
  const out: Row[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of kids.get(id) ?? []) {
      const hasChildren = (kids.get(c.id) ?? []).length > 0;
      out.push({ c, depth, hasChildren });
      if (hasChildren && !collapsed.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(goalId, 1);
  return out;
}

export function evidenceCount(links: Link[], id: string): number {
  return links.filter((l) => l.from === id && l.rel === "evidence" && !l.removed).length;
}

/** Lessons on a concept and its ancestors, nearest first (not superseded). */
export function lessonsFor(
  byId: Map<string, Concept>,
  kids: Map<string | null, Concept[]>,
  id: string,
): Concept[] {
  const out: Concept[] = [];
  let cur = byId.get(id);
  while (cur) {
    for (const k of kids.get(cur.id) ?? [])
      if (k.kind === "lesson" && k.lessonState !== "superseded") out.push(k);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Counts for a goal's progress line. */
export function progress(
  kids: Map<string | null, Concept[]>,
  goalId: string,
): { done: number; total: number; running: number } {
  let done = 0;
  let total = 0;
  let running = 0;
  const walk = (id: string) => {
    for (const c of kids.get(id) ?? []) {
      if (c.kind === "task") {
        if (c.status === "abandoned" || c.status === "dropped") {
          walk(c.id);
          continue;
        }
        total++;
        if (c.status === "done") done++;
        if (c.status === "running") running++;
      }
      walk(c.id);
    }
  };
  walk(goalId);
  return { done, total, running };
}
