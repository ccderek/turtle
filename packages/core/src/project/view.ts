import { shortestUniquePrefixes } from "../ids.js";
import type { Project } from "./project.js";
import type { Concept } from "./types.js";

export interface GraphTreeNode {
  concept: Concept;
  children: GraphTreeNode[];
}

const KIND_ORDER: Record<string, number> = {
  task: 0,
  question: 1,
  decision: 2,
  finding: 3,
  output: 4,
  goal: 5,
};

/** The graph under each goal (or one goal) as a tree, children in display order. */
export function graphTree(
  project: Project,
  o: { goalId?: string; includeDropped?: boolean } = {},
): GraphTreeNode[] {
  const all = project.db.listConcepts({ includeDropped: o.includeDropped ?? false });
  const kids = new Map<string | null, Concept[]>();
  for (const c of all) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
  const build = (c: Concept): GraphTreeNode => ({
    concept: c,
    children: (kids.get(c.id) ?? [])
      .sort(
        (a, b) =>
          (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
          (a.order ?? "").localeCompare(b.order ?? "") ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .map(build),
  });
  const roots = (kids.get(null) ?? []).filter(
    (c) => c.kind === "goal" && (!o.goalId || c.id === o.goalId),
  );
  return roots.map(build);
}

/** Display ids: shortest unique prefix of the part after `c_` (at least 4 characters). */
export function shortConceptIds(project: Project): (id: string) => string {
  const ids = project.db.listConcepts({ includeDropped: true }).map((c) => c.id.slice(2));
  const map = shortestUniquePrefixes(ids);
  return (id) => map.get(id.slice(2)) ?? id.slice(2, 8);
}
