import type { Concept, ConceptFields, Link, Project } from "@turtle/core";
import type { ConceptDetailResponse, GraphResponse, ProjectResponse } from "./api.js";

export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CREATE_FIELDS = new Set([
  "kind",
  "parentId",
  "title",
  "body",
  "status",
  "assignee",
  "dependsOn",
  "sources",
  "resources",
  "startFrom",
  "options",
  "order",
]);

function pick(body: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (allowed.has(k)) out[k] = v;
  return out;
}

/** Task-graph endpoints (docs/phase2-spec.md §13). Return undefined when not matched. */
export function graphRoutes(project: Project) {
  const concept = (id: string): Concept => {
    const c = project.db.getConcept(id);
    if (!c) throw new RouteError(404, `unknown concept: ${id}`);
    return c;
  };

  return {
    get(parts: string[], url: URL): unknown {
      const [, a, b, c] = parts;
      if (a === "project" && !b) {
        const r: ProjectResponse = {
          name: project.config.name,
          dir: project.dir,
          sources: project.config.sources,
          resources: project.config.resources,
          defaults: project.config.defaults,
          me: { memberId: project.identity.memberId, name: project.identity.name },
        };
        return r;
      }
      if (a === "graph" && !b) {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const cursor = project.db.maxOrd();
        if (since > 0 && since <= cursor) {
          const t = project.db.touchedSince(since);
          const r: GraphResponse = {
            cursor,
            full: false,
            concepts: t.concepts
              .map((id) => project.db.getConcept(id))
              .filter((x): x is Concept => x !== null),
            links: t.links.map((id) => project.db.getLink(id)).filter((x): x is Link => x !== null),
          };
          return r;
        }
        const r: GraphResponse = {
          cursor,
          full: true,
          concepts: project.db.listConcepts({ includeDropped: true }),
          links: project.db.listLinks({ includeRemoved: true }),
        };
        return r;
      }
      if (a === "concepts" && b && !c) {
        const r: ConceptDetailResponse = {
          concept: concept(b),
          links: project.db.listLinks({ from: b }),
          backlinks: project.db.listLinks({ to: { type: "concept", id: b } }),
          history: project.db.listOps({ concept: b }).map((o) => ({
            id: o.id,
            at: o.at,
            actor: o.actor,
            kind: o.change.kind,
            batch: o.batch,
          })),
        };
        return r;
      }
      return undefined;
    },

    async post(parts: string[], body: Record<string, unknown>): Promise<unknown> {
      const [, a, b, c] = parts;
      if (a === "concepts" && !b) {
        const fields = pick(body, CREATE_FIELDS) as unknown as ConceptFields;
        if (typeof fields.title !== "string") throw new RouteError(400, "title is required");
        return project.createConcept(fields);
      }
      if (a === "concepts" && b && !c) {
        const fields = (body.fields ?? {}) as Partial<Omit<ConceptFields, "kind">>;
        const base = typeof body.base === "number" ? body.base : undefined;
        concept(b);
        return project.updateConcept(b, fields, base === undefined ? {} : { base });
      }
      if (a === "concepts" && b && c === "drop") {
        concept(b);
        return project.dropConcept(b);
      }
      if (a === "questions" && b && c === "answer") {
        return project.answerQuestion(b, String(body.text ?? ""));
      }
      if (a === "ops" && b && c === "undo") {
        return { undone: (await project.undo(b)).length };
      }
      return undefined;
    },
  };
}
