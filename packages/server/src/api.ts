/**
 * Shapes of the turtle ui HTTP API (docs/phase1-spec.md §5). Type-only: the web client
 * imports this file directly.
 */
import type {
  Actor,
  Agent,
  Artifact,
  Branch,
  Concept,
  Link,
  NodeKind,
  NodeStatus,
  ProjectConfig,
  SandboxMode,
  Snapshot,
  SourceConfig,
  TurtleNode,
} from "@turtle/core";

export type { Agent, Artifact, Branch, NodeKind, NodeStatus, SandboxMode, Snapshot, TurtleNode };

export interface NodeView extends TurtleNode {
  /** Nearest displayed ancestor (micro snapshots are skipped unless shown). */
  displayParent: string | null;
  /** Micro snapshots collapsed between displayParent and this node. */
  hiddenSteps: number;
}

export interface BranchView extends Branch {
  /** The head, or its nearest non-micro ancestor: where the tree marks the branch. */
  checkpointHeadId: string | null;
  /** Micro snapshots after checkpointHeadId: work since the last checkpoint. */
  pendingSteps: number;
  costUsd: number;
  /** Error of the last run when it failed. */
  lastError: string | null;
}

export interface AgentView extends Agent {
  /** Reported cost when the run ended, else the estimate from token usage so far. */
  costUsd: number;
  maxBudgetUsd: number | null;
  /** Started by this turtle ui process (stop is instant; others are signalled). */
  ownedByUi: boolean;
}

export type AttentionKind = "need_decision" | "blocked" | "failed" | "tests_failing" | "budget";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  branchId: string;
  /** The checkpoint to look at. */
  nodeId: string | null;
  /** Where "continue" starts (the branch head, possibly a micro snapshot). */
  headNodeId: string | null;
  agentId: string | null;
  title: string;
  detail: string | null;
  at: string;
}

export interface StateResponse {
  repo: { root: string; name: string };
  defaults: { sandbox: SandboxMode; model: string | null; maxBudgetUsd: number | null };
  branches: BranchView[];
  agents: AgentView[];
  nodes: NodeView[];
  snapshots: Snapshot[];
  attention: AttentionItem[];
  totals: { costUsd: number; running: number; nodes: number; micro: number };
}

export type TranscriptItem = {
  agentId: string;
  seq: number;
  nodeId: string | null;
  sub: boolean;
} & (
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; summary: string; input: string }
  | { kind: "tool_result"; toolUseId: string; text: string; isError: boolean }
  | { kind: "result"; subtype: string; costUsd: number | null; numTurns: number | null }
  | { kind: "system"; text: string }
);

export interface TranscriptResponse {
  agent: AgentView;
  items: TranscriptItem[];
  lastSeq: number;
}

export interface NodeDetailResponse {
  node: NodeView;
  branch: BranchView | null;
  agent: AgentView | null;
  /** What "changes" are measured against (previous checkpoint for semantic nodes). */
  base: NodeView | null;
  children: NodeView[];
  artifacts: Artifact[];
  snapshots: string[];
  /** Messages that led to this node (this node and the micro snapshots just before it). */
  steps: TranscriptItem[];
  /** True when this node is its branch's head and the branch is not running. */
  canContinue: boolean;
}

export interface DiffResponse {
  base: { id: string; kind: NodeKind } | null;
  diff: string;
  truncated: boolean;
}

export interface RunRequest {
  prompt: string;
  from?: string;
  fork?: boolean;
  fromHead?: boolean;
  sandbox?: SandboxMode;
  model?: string;
  budget?: number;
  name?: string;
}

export interface RunResponse {
  agentId: string;
  branchId: string;
  mode: "new" | "continue" | "fork";
}

export interface ErrorResponse {
  error: string;
}

/** Server-sent events on GET /api/events. */
export type LiveEvent =
  | { type: "hello"; pid: number }
  | { type: "change" }
  | {
      type: "log";
      agentId: string;
      branchId: string;
      level: "info" | "warn" | "error";
      message: string;
    };

// ------------------------------------------------------------ Phase 2: task graph

export type { Actor, Concept, Link, SourceConfig };

export interface ProjectResponse {
  name: string;
  dir: string;
  sources: SourceConfig[];
  resources: ProjectConfig["resources"];
  defaults: ProjectConfig["defaults"];
  me: { memberId: string; name: string };
}

export interface GraphResponse {
  /** Pass back as `?since=` to get only what changed. */
  cursor: number;
  /** false: only concepts and links touched since the cursor. */
  full: boolean;
  concepts: Concept[];
  links: Link[];
}

export interface ConceptDetailResponse {
  concept: Concept;
  links: Link[];
  backlinks: Link[];
  history: { id: string; at: string; actor: Actor; kind: string; batch: string }[];
}
