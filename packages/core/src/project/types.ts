/** Task graph types (docs/phase2-spec.md §5–§6, architecture §3.5). */

export type ConceptKind =
  | "goal"
  | "task"
  | "finding"
  | "decision"
  | "question"
  | "output"
  | "lesson"
  | "check";

export const CONCEPT_KINDS: readonly ConceptKind[] = [
  "goal",
  "task",
  "finding",
  "decision",
  "question",
  "output",
  "lesson",
  "check",
];

export type TaskStatus =
  | "todo"
  | "running"
  | "paused"
  | "need_decision"
  | "blocked"
  | "done"
  | "failed"
  | "abandoned"
  | "dropped";

export type Actor =
  | { type: "member"; id: string }
  | { type: "agent"; id: string; onBehalfOf: string };

export interface StartFrom {
  taskId: string;
  checkpointId: string;
}

/** Fields a concept carries; which ones apply depends on `kind`. */
export interface ConceptFields {
  kind: ConceptKind;
  parentId: string | null;
  title: string;
  body?: string;
  // task
  status?: TaskStatus;
  assignee?: { type: "agent" } | { type: "member"; id: string } | null;
  dependsOn?: string[];
  sources?: string[];
  resources?: string[];
  startFrom?: StartFrom | null;
  /** A planner task splits its goal: its agent may create tasks next to itself. */
  role?: "planner";
  /** Code branches this task's work landed on, one per source. */
  branches?: { source: string; branch: string }[];
  brief?: string;
  // question
  options?: string[];
  answer?: { text: string; by: string; at: string } | null;
  // output
  path?: string;
  sha256?: string;
  size?: number;
  // lesson: applies to the subtree of parentId (architecture D28/D30)
  lessonState?: "proposed" | "confirmed" | "superseded";
  // check: an executable acceptance condition for the subtree of parentId (D31)
  /** File name of the check script; its extension picks the interpreter. */
  file?: string;
  script?: string;
  checkState?: "proposed" | "active" | "retired";
  // task: the latest result of each check in scope, by check id
  checkResults?: Record<string, CheckResult>;
  // ordering among siblings
  order?: string;
}

export type ConceptField = Exclude<keyof ConceptFields, "kind">;

/** One run of a check against a task's workspace (architecture §3.7). */
export interface CheckResult {
  ok: boolean;
  at: string;
  /** The checkpoint it judged, if any. */
  checkpointId: string | null;
  /** The check's output (its explanation), clipped. */
  output: string;
  ms: number;
}

export interface Concept extends ConceptFields {
  id: string;
  /** Number of operations applied to this concept. */
  version: number;
  dropped: boolean;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  /** Per field: the version that last set it and who. Drives stale-edit checks. */
  fieldMeta: Partial<Record<ConceptField, { v: number; by: Actor }>>;
}

export type LinkRel = "evidence" | "provenance" | "reuses" | "enforces";

export interface LinkTarget {
  type: "checkpoint" | "node" | "artifact" | "output" | "concept" | "message";
  id: string;
}

export interface Link {
  id: string;
  from: string;
  rel: LinkRel;
  to: LinkTarget;
  createdBy: Actor;
  createdAt: string;
  removed: boolean;
}

export type Change =
  | { kind: "create"; id: string; fields: ConceptFields }
  | { kind: "set"; id: string; fields: Partial<Omit<ConceptFields, "kind">>; base: number }
  | { kind: "drop"; id: string; base: number }
  | { kind: "restore"; id: string }
  | { kind: "link"; id: string; from: string; rel: LinkRel; to: LinkTarget }
  | { kind: "unlink"; id: string };

/** One immutable change; the unit of the operation log. */
export interface Operation {
  /** sha256 of the canonical JSON of every other field. */
  id: string;
  /** `${memberId}/${replicaId}`. */
  replica: string;
  /** Per-replica sequence number, 1, 2, 3, … */
  seq: number;
  /** Version vector: highest seq seen per replica when this was written. */
  deps: Record<string, number>;
  actor: Actor;
  at: string;
  change: Change;
}

export function actorLabel(a: Actor): string {
  return a.type === "member" ? a.id : `${a.id} for ${a.onBehalfOf}`;
}
