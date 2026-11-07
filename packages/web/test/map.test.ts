import type { Concept } from "@turtle/server/api";
import { describe, expect, it } from "vitest";
import { countsOf, layoutGoal, MAP } from "../src/tasks/map.js";
import { childrenMap } from "../src/tasks/tree.js";

let n = 0;
function concept(kind: Concept["kind"], parentId: string | null, extra: Partial<Concept> = {}) {
  n++;
  return {
    id: `c_${n}`,
    kind,
    parentId,
    title: `${kind} ${n}`,
    version: 1,
    dropped: false,
    createdBy: { type: "member", id: "m_1" },
    createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    updatedAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    fieldMeta: {},
    ...extra,
  } as Concept;
}

describe("mind map layout", () => {
  const goal = concept("goal", null);
  const a = concept("task", goal.id, { status: "done" });
  const a1 = concept("task", a.id);
  const a2 = concept("task", a.id);
  const lesson = concept("lesson", a.id, { lessonState: "confirmed" });
  const finding = concept("finding", a.id);
  const b = concept("task", goal.id, { dependsOn: [a.id] });
  const c = concept("task", goal.id, { dependsOn: [a.id, b.id] });
  const all = [goal, a, a1, a2, lesson, finding, b, c];
  const kids = childrenMap(all);

  it("puts depth to the right and never overlaps cards", () => {
    const l = layoutGoal(goal, kids, new Set());
    const by = new Map(l.nodes.map((x) => [x.c.id, x]));
    expect(by.get(goal.id)?.depth).toBe(0);
    expect(by.get(a1.id)?.depth).toBe(2);
    expect((by.get(a1.id)?.x ?? 0) > (by.get(a.id)?.x ?? 0)).toBe(true);
    // Findings are counted on the card, not drawn.
    expect(by.has(finding.id)).toBe(false);
    expect(by.has(lesson.id)).toBe(true);
    for (const p of l.nodes)
      for (const q of l.nodes) {
        if (p === q || p.x !== q.x) continue;
        const apart = p.y + p.h <= q.y || q.y + q.h <= p.y;
        expect(apart, `${p.c.title} overlaps ${q.c.title}`).toBe(true);
      }
    expect(l.height).toBeGreaterThan(MAP.taskH * 3);
  });

  it("centres a parent on its children", () => {
    const l = layoutGoal(goal, kids, new Set());
    const by = new Map(l.nodes.map((x) => [x.c.id, x]));
    const mid = (x: (typeof l.nodes)[number]) => x.y + x.h / 2;
    const first = by.get(lesson.id);
    const last = by.get(a2.id);
    const parent = by.get(a.id);
    if (!first || !last || !parent) throw new Error("missing node");
    expect(mid(parent)).toBeCloseTo((mid(first) + mid(last)) / 2, 5);
  });

  it("draws one tree edge per shown child and one arrow per dependency", () => {
    const l = layoutGoal(goal, kids, new Set());
    expect(l.edges).toHaveLength(l.nodes.length - 1);
    expect(l.deps.map((d) => `${d.from}>${d.to}`).sort()).toEqual(
      [`${a.id}>${b.id}`, `${a.id}>${c.id}`, `${b.id}>${c.id}`].sort(),
    );
  });

  it("hides a collapsed task's children", () => {
    const l = layoutGoal(goal, kids, new Set([a.id]));
    const ids = new Set(l.nodes.map((x) => x.c.id));
    expect(ids.has(a1.id)).toBe(false);
    expect(l.nodes.find((x) => x.c.id === a.id)?.foldable).toBe(true);
  });

  it("counts what it does not draw", () => {
    expect(countsOf(kids, a.id)).toEqual(["1 finding"]);
  });
});
