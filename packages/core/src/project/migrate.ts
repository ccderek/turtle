import { join } from "node:path";
import { TurtleDb } from "../db/db.js";
import type { Branch, BranchStatus, TurtleNode } from "../db/types.js";
import { GitStore } from "../git/store.js";
import { checkpointOf } from "../ops.js";
import type { Project } from "./project.js";
import type { Concept, TaskStatus } from "./types.js";

export const IMPORTED_GOAL_TITLE = "Imported runs";

const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0] ?? "";

function taskStatusFor(b: Branch, cp: TurtleNode | null): TaskStatus {
  const map: Record<BranchStatus, TaskStatus> = {
    running: "running",
    idle: "blocked",
    done: "done",
    killed: "paused",
    failed: "failed",
  };
  if (b.status === "idle" && cp?.status === "need_decision") return "need_decision";
  return map[b.status];
}

/** The task that tracks a source branch, if any. */
export function taskForBranch(project: Project, source: string, branch: string): Concept | null {
  return (
    project.db
      .listConcepts({ kind: "task", includeDropped: true })
      .find((t) => t.branches?.some((b) => b.source === source && b.branch === branch)) ?? null
  );
}

/**
 * Bring Phase 0–1 branches of one source into the graph as tasks under a goal
 * "Imported runs" (docs/phase2-spec.md §4.3). Idempotent: a branch already tracked by a
 * task is skipped. Returns the tasks created.
 */
export async function importSourceBranches(
  project: Project,
  sourceId: string,
  db?: TurtleDb,
): Promise<Concept[]> {
  const source = project.config.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);
  let ownDb: TurtleDb | null = null;
  if (!db) {
    const store = await GitStore.open(source.path);
    ownDb = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    db = ownDb;
  }
  try {
    const branches = db.listBranches().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const todo = branches.filter((b) => !taskForBranch(project, sourceId, b.id));
    if (!todo.length) return [];
    let goal = project.db
      .listConcepts({ kind: "goal" })
      .find((g) => g.title === IMPORTED_GOAL_TITLE);
    goal ??= await project.createConcept({
      kind: "goal",
      parentId: null,
      title: IMPORTED_GOAL_TITLE,
      body: "Runs recorded before this repository had a task graph.",
    });
    const created: Concept[] = [];
    for (const b of todo) {
      const agents = db
        .listAgents({ branchId: b.id })
        .sort((x, y) => x.startedAt.localeCompare(y.startedAt));
      const head = b.headNodeId ? db.getNode(b.headNodeId) : null;
      const cp = checkpointOf(db, head);
      const status = taskStatusFor(b, cp);
      let startFrom: Concept["startFrom"] = null;
      let parentId = goal.id;
      if (b.forkedFromNodeId) {
        const fromNode = db.getNode(b.forkedFromNodeId);
        const parentTask = fromNode ? taskForBranch(project, sourceId, fromNode.branchId) : null;
        if (parentTask) {
          startFrom = { taskId: parentTask.id, checkpointId: b.forkedFromNodeId };
          parentId = parentTask.parentId ?? goal.id;
        }
      }
      const title = b.name ?? (firstLine(agents[0]?.prompt) || `branch ${b.id.slice(0, 6)}`);
      const task = await project.createConcept({
        kind: "task",
        parentId,
        title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
        body: agents.map((a) => a.prompt).join("\n\n---\n\n"),
        status,
        assignee: { type: "agent" },
        startFrom,
        branches: [{ source: sourceId, branch: b.id }],
        brief: cp && cp.kind !== "root" ? (cp.summary ?? "") : "",
      });
      if (cp && cp.kind !== "root")
        await project.link(task.id, "evidence", { type: "node", id: cp.id });
      if (startFrom)
        await project.link(task.id, "reuses", { type: "concept", id: startFrom.taskId });
      if (status === "need_decision" && cp) {
        await project.createConcept({
          kind: "question",
          parentId: task.id,
          title: firstLine(cp.summary) || "The agent is waiting for an answer",
          body: cp.summary ?? "",
        });
      }
      created.push(task);
    }
    return created;
  } finally {
    ownDb?.close();
  }
}

/** Import every source's branches. */
export async function importAllSources(project: Project): Promise<Concept[]> {
  const out: Concept[] = [];
  for (const s of project.config.sources) out.push(...(await importSourceBranches(project, s.id)));
  return out;
}
