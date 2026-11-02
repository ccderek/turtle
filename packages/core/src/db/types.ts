export type BranchStatus = "running" | "idle" | "done" | "killed" | "failed";
export type AgentStatus = "starting" | "running" | "done" | "killed" | "failed";
export type SandboxMode = "none" | "docker";
export type NodeKind = "root" | "micro" | "semantic" | "human_edit" | "merge";
export type NodeStatus = "progress" | "done" | "blocked" | "need_decision" | "killed" | "failed";
export type SummarySource = "agent_declared" | "rule_auto" | "human";
export type TestStatus = "pass" | "fail" | "none";
export type ActorType = "agent" | "human" | "system";

export interface Branch {
  id: string;
  name: string | null;
  ref: string;
  rootNodeId: string;
  forkedFromNodeId: string | null;
  headNodeId: string | null;
  workspacePath: string | null;
  status: BranchStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  branchId: string;
  adapter: string;
  adapterLevel: 0 | 1 | 2;
  model: string | null;
  sandbox: SandboxMode;
  sessionId: string | null;
  prompt: string;
  status: AgentStatus;
  startedAt: string;
  endedAt: string | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  pid: number | null;
}

export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export const ZERO_TOKENS: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export interface TurtleNode {
  id: string;
  branchId: string;
  agentId: string | null;
  kind: NodeKind;
  parents: string[];
  commitSha: string;
  treeSha: string;
  intent: string | null;
  summary: string | null;
  summarySource: SummarySource | null;
  status: NodeStatus;
  trigger: string | null;
  sessionId: string | null;
  resumeToolUseId: string | null;
  resumeMessageUuid: string | null;
  tests: TestStatus | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  tokens: TokenUsage;
  costUsdEst: number;
  tags: string[];
  explorationGroupId: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  nodeId: string;
  label: string | null;
  path: string | null;
  blobSha: string;
  mime: string | null;
  size: number | null;
}

export interface StoredMessage {
  agentId: string;
  seq: number;
  sessionId: string | null;
  uuid: string | null;
  type: string;
  parentToolUseId: string | null;
  nodeId: string | null;
  json: string;
}

export interface TurtleEvent {
  seq: number;
  id: string;
  at: string;
  actorType: ActorType;
  actorId: string | null;
  type: string;
  branchId: string | null;
  nodeId: string | null;
  agentId: string | null;
  payload: Record<string, unknown>;
}

export interface Snapshot {
  name: string;
  nodeId: string;
  createdAt: string;
}
