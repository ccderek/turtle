import {
  type Actor,
  type Concept,
  type ConceptFields,
  type Link,
  type Project,
  stopTask,
  tellTask,
} from "@turtle/core";
import type { ActivityItem, ConceptDetailResponse, GraphResponse, ProjectResponse } from "./api.js";
import type { TaskRunner } from "./tasks.js";

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
  "lessonState",
]);

function pick(body: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (allowed.has(k)) out[k] = v;
  return out;
}

const PLANNER_BODY = `Split the goal into tasks. Create each task with mcp__turtle__task (op "create"); they are placed next to this planning task, under the goal. Give each task a body that says what it must do and how to know it is done, and use dependsOn when a task needs another one's results. Prefer 3–7 tasks. Record what you assumed as decisions; ask with mcp__turtle__question if the goal is unclear in a way that changes the plan. Do not do the work yourself.`;

/** Task-graph endpoints (docs/phase2-spec.md §13). Return undefined when not matched. */
export function graphRoutes(project: Project, tasks: TaskRunner | null = null) {
  const concept = (id: string): Concept => {
    const c = project.db.getConcept(id);
    if (!c) throw new RouteError(404, `unknown concept: ${id}`);
    return c;
  };
  const task = (id: string): Concept => {
    const c = concept(id);
    if (c.kind !== "task") throw new RouteError(400, `${id} is not a task`);
    return c;
  };
  const needTasks = (): TaskRunner => {
    if (!tasks) throw new RouteError(400, "this server does not run agents");
    return tasks;
  };
  const actorName = (a: Actor) =>
    a.type === "member"
      ? a.id === project.identity.memberId
        ? project.identity.name
        : a.id
      : `agent ${a.id.slice(0, 6)}`;

  const STATUS_TEXT: Record<string, string> = {
    need_decision: "needs you",
    todo: "to do",
  };
  function activity(limit: number): ActivityItem[] {
    const ops = project.db
      .listOps()
      .slice(-limit * 3)
      .reverse();
    const out: ActivityItem[] = [];
    for (const op of ops) {
      const c = op.change;
      const who = actorName(op.actor);
      const title = (id: string) => project.db.getConcept(id)?.title ?? id;
      let text: string | null = null;
      let id: string | null = null;
      if (c.kind === "create") {
        id = c.id;
        const verb: Record<string, string> = {
          goal: "set the goal",
          task: "added task",
          finding: "recorded a finding:",
          decision: "decided:",
          question: "asked:",
          output: "produced",
          lesson: "added a lesson:",
          check: "added a check:",
          recipe: "recorded a recipe:",
        };
        text = `${verb[c.fields.kind] ?? "added"} ${c.fields.kind === "output" ? (c.fields.path ?? c.fields.title) : `"${c.fields.title}"`}`;
      } else if (c.kind === "set") {
        id = c.id;
        if (c.fields.status)
          text = `"${title(c.id)}" → ${STATUS_TEXT[c.fields.status] ?? c.fields.status}`;
        else if (c.fields.answer) text = `answered "${title(c.id)}": ${c.fields.answer.text}`;
        else if (c.fields.lessonState) text = `lesson "${title(c.id)}" → ${c.fields.lessonState}`;
        else if (c.fields.checkState) text = `check "${title(c.id)}" → ${c.fields.checkState}`;
        else if (c.fields.recipeState && c.fields.recipeState !== "verifying")
          text = `recipe "${title(c.id)}" → ${c.fields.recipeState}${
            c.fields.recipeState === "failed" && c.fields.verification?.problems?.[0]
              ? `: ${c.fields.verification.problems[0]}`
              : ""
          }`;
        else if (c.fields.replay?.result)
          text = c.fields.replay.result.ok
            ? `replayed the recipe for "${title(c.id)}" (no model)`
            : `the recipe failed for "${title(c.id)}"`;
        else if (c.fields.checkResults) {
          const failed = Object.entries(c.fields.checkResults).filter(([, r]) => !r.ok);
          text = failed.length
            ? `checks on "${title(c.id)}": ${failed.length} failed (${failed.map(([k]) => title(k)).join(", ")})`
            : null;
        } else if (c.fields.brief) text = `updated the brief of "${title(c.id)}"`;
        else if (c.fields.title || c.fields.body || c.fields.dependsOn)
          text = `edited "${title(c.id)}"`;
      } else if (c.kind === "drop") {
        id = c.id;
        text = `dropped "${title(c.id)}"`;
      }
      if (!text) continue;
      const prev = out.at(-1);
      if (prev && prev.text === text && prev.who === who) continue;
      out.push({
        id: op.id,
        at: op.at,
        who,
        byAgent: op.actor.type === "agent",
        conceptId: id,
        text,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

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
        const all = project.db.listConcepts({ includeDropped: true });
        const waiting: Record<string, string> = {};
        if (tasks)
          for (const t of all)
            if (t.kind === "task") {
              const w = tasks.waitingReason(t);
              if (w) waiting[t.id] = w;
            }
        const cursor = project.db.maxOrd();
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const delta = since > 0 && since <= cursor ? project.db.touchedSince(since) : null;
        const r: GraphResponse = {
          cursor,
          full: !delta,
          concepts: delta
            ? delta.concepts
                .map((id) => project.db.getConcept(id))
                .filter((x): x is Concept => x !== null)
            : all,
          links: delta
            ? delta.links.map((id) => project.db.getLink(id)).filter((x): x is Link => x !== null)
            : project.db.listLinks({ includeRemoved: true }),
          running: tasks ? [...tasks.runningTasks()] : [],
          waiting,
          autoStart: tasks?.autoStart ?? false,
          maxParallel: tasks?.maxParallel ?? 0,
        };
        return r;
      }
      if (a === "activity" && !b)
        return activity(Math.min(200, Number(url.searchParams.get("limit") ?? 40) || 40));
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
          lessons: project.lessonsInScope(b),
        };
        return r;
      }
      return undefined;
    },

    async post(parts: string[], body: Record<string, unknown>): Promise<unknown> {
      const [, a, b, c] = parts;
      if (a === "recipes" && !b) {
        const taskId = String(body.taskId ?? "");
        const title = String(body.title ?? "").trim();
        if (!taskId || !title) throw new RouteError(400, "taskId and title are required");
        const params: Record<string, string> = {};
        if (body.params && typeof body.params === "object")
          for (const [k, v] of Object.entries(body.params as Record<string, unknown>))
            params[k] = String(v);
        return project.addRecipe({
          taskId: task(taskId).id,
          title,
          file: String(body.file ?? ""),
          script: String(body.script ?? ""),
          params,
          outputs: Array.isArray(body.outputs) ? body.outputs.map(String) : [],
          tolerance: typeof body.tolerance === "number" ? body.tolerance : 0,
        });
      }
      if (a === "recipes" && b && c === "verify") {
        const r = concept(b);
        if (r.kind !== "recipe") throw new RouteError(400, `${b} is not a recipe`);
        const runner = needTasks();
        if (runner.verifying.has(b)) return { started: false, verifying: true };
        void runner.verify(b).catch(() => {});
        return { started: true };
      }
      if (a === "recipes" && b && c === "replay") {
        const params: Record<string, string> = {};
        if (body.params && typeof body.params === "object")
          for (const [k, v] of Object.entries(body.params as Record<string, unknown>))
            params[k] = String(v);
        const t = await project.replayRecipe(
          b,
          params,
          typeof body.title === "string" && body.title.trim() ? { title: body.title } : {},
        );
        if (tasks?.autoStart) void tasks.tick();
        return t;
      }
      if (a === "checks" && !b) {
        const on = String(body.on ?? "");
        const title = String(body.title ?? "").trim();
        if (!on || !title) throw new RouteError(400, "on and title are required");
        return project.addCheck({
          on: concept(on).id,
          title,
          file: String(body.file ?? ""),
          script: String(body.script ?? ""),
          ...(typeof body.body === "string" && body.body ? { body: body.body } : {}),
        });
      }
      if (a === "goals" && !b) {
        const title = String(body.title ?? "").trim();
        if (!title) throw new RouteError(400, "title is required");
        const goal = await project.createConcept({
          kind: "goal",
          parentId: null,
          title,
          body: String(body.body ?? ""),
        });
        let planner: Concept | null = null;
        if (body.plan) {
          planner = await project.createConcept({
            kind: "task",
            parentId: goal.id,
            title: "Plan the work",
            body: PLANNER_BODY,
            role: "planner",
            assignee: { type: "agent" },
          });
          if (tasks?.autoStart) void tasks.tick();
        }
        return { goal, planner };
      }
      if (a === "concepts" && !b) {
        const fields = pick(body, CREATE_FIELDS) as unknown as ConceptFields;
        if (typeof fields.title !== "string") throw new RouteError(400, "title is required");
        const created = await project.createConcept(fields);
        if (created.kind === "task" && tasks?.autoStart) void tasks.tick();
        return created;
      }
      if (a === "concepts" && b && !c) {
        const fields = (body.fields ?? {}) as Partial<Omit<ConceptFields, "kind">>;
        const base = typeof body.base === "number" ? body.base : undefined;
        const before = concept(b);
        const after = await project.updateConcept(b, fields, base === undefined ? {} : { base });
        // A member's edit of a running task is an instruction to its agent (§11).
        if (
          after.kind === "task" &&
          before.status === "running" &&
          (fields.title || fields.body || fields.dependsOn)
        ) {
          const changes = [
            fields.title && fields.title !== before.title
              ? `the title is now "${fields.title}"`
              : null,
            fields.body !== undefined && fields.body !== before.body
              ? `the description is now:\n${fields.body}`
              : null,
            fields.dependsOn ? "its dependencies changed" : null,
          ].filter(Boolean);
          if (changes.length)
            await tellTask(
              project,
              b,
              `I changed this task: ${changes.join("; ")}. Adjust your work to match.`,
            ).catch(() => undefined);
        }
        if (tasks?.autoStart) void tasks.tick();
        return after;
      }
      if (a === "concepts" && b && c === "drop") {
        concept(b);
        return project.dropConcept(b);
      }
      if (a === "questions" && b && c === "answer") {
        const d = await project.answerQuestion(b, String(body.text ?? ""));
        const q = concept(b);
        const parent = q.parentId ? project.getConcept(q.parentId) : null;
        let started: unknown = null;
        if (
          body.continue !== false &&
          parent?.kind === "task" &&
          parent.status === "need_decision" &&
          tasks
        ) {
          const open = project.db
            .listConcepts({ parentId: parent.id, kind: "question" })
            .some((x) => !x.answer);
          if (!open) started = await tasks.start(parent.id);
        }
        return { decision: d, started };
      }
      if (a === "ops" && b && c === "undo") return { undone: (await project.undo(b)).length };
      if (a === "scheduler" && !b) {
        const t = needTasks();
        if (typeof body.autoStart === "boolean") t.autoStart = body.autoStart;
        if (t.autoStart) void t.tick();
        return { autoStart: t.autoStart };
      }
      if (a === "tasks" && b) {
        task(b);
        if (c === "start")
          return needTasks().start(b, {
            ...(typeof body.instruction === "string" && body.instruction.trim()
              ? { instruction: body.instruction }
              : {}),
            ...(body.sandbox === "none" || body.sandbox === "docker"
              ? { sandbox: body.sandbox }
              : {}),
            ...(typeof body.model === "string" && body.model.trim()
              ? { model: body.model.trim() }
              : {}),
            ...(typeof body.budget === "number" && body.budget > 0 ? { budget: body.budget } : {}),
          });
        if (c === "tell") return tellTask(project, b, String(body.text ?? ""));
        if (c === "from-here") {
          const title = String(body.title ?? "").trim();
          if (!title) throw new RouteError(400, "title is required");
          const t = await project.taskFromHere(
            b,
            title,
            typeof body.body === "string" && body.body ? { body: body.body } : {},
          );
          if (tasks?.autoStart) void tasks.tick();
          return t;
        }
        if (c === "pause") return stopTask(project, b);
        if (c === "drop") return stopTask(project, b, { drop: true });
        if (c === "abandon") {
          if (project.getConcept(b)?.status === "running") await stopTask(project, b);
          return project.abandonTask(b, {
            ...(typeof body.lesson === "string" && body.lesson.trim()
              ? { lesson: body.lesson.trim() }
              : {}),
            ...(typeof body.on === "string" && body.on ? { on: body.on } : {}),
          });
        }
      }
      if (a === "nodes-retry" && b) {
        const title = String(body.title ?? "").trim();
        if (!title) throw new RouteError(400, "title is required");
        const t = await project.retryTask(
          b,
          title,
          typeof body.body === "string" && body.body ? { body: body.body } : {},
        );
        if (tasks?.autoStart) void tasks.tick();
        return t;
      }
      return undefined;
    },
  };
}

export type { Link };
