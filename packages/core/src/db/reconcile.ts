import { runGit } from "../git/exec.js";
import { parseNodeMessage } from "../git/message.js";
import { BRANCH_REF_PREFIX, type GitStore, SNAPSHOT_REF_PREFIX } from "../git/store.js";
import type { TurtleDb } from "./db.js";
import { type NodeKind, type NodeStatus, type SummarySource, ZERO_TOKENS } from "./types.js";

export interface ReconcileReport {
  importedNodes: string[];
  createdBranches: string[];
  failedAgents: string[];
}

const NODE_KINDS: readonly NodeKind[] = ["root", "micro", "semantic", "human_edit", "merge"];
const NODE_STATUSES: readonly NodeStatus[] = [
  "progress",
  "done",
  "blocked",
  "need_decision",
  "killed",
  "failed",
];
const SUMMARY_SOURCES: readonly SummarySource[] = ["agent_declared", "rule_auto", "human"];

interface ParsedCommit {
  sha: string;
  tree: string;
  parents: string[];
  date: string;
  message: string;
}

/**
 * Bring the DB in line with git after a crash (docs/phase0-spec.md §6.6):
 * import commits that carry a Turtle-Node trailer but have no row, and mark agents
 * whose orchestrator process is gone as failed.
 */
export async function reconcile(
  store: GitStore,
  db: TurtleDb,
  opts: { isProcessAlive?: (pid: number) => boolean } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = { importedNodes: [], createdBranches: [], failedAgents: [] };
  const refs = [
    ...(await store.listRefs(BRANCH_REF_PREFIX)),
    ...(await store.listRefs(SNAPSHOT_REF_PREFIX)),
  ];

  for (const { ref, sha } of refs) {
    const missing: ParsedCommit[] = [];
    for await (const commit of walk(store, sha)) {
      const trailers = parseNodeMessage(commit.message).trailers;
      const nodeId = trailers["Turtle-Node"];
      if (!nodeId || db.getNode(nodeId)) break;
      missing.push(commit);
    }
    for (const commit of missing.reverse()) {
      const imported = await importCommit(store, db, ref, commit, report);
      if (imported) report.importedNodes.push(imported);
    }
    // Move the head forward only over commits imported just now. A ref that moved to an
    // older node is a real inconsistency for `turtle doctor` to report, not to hide.
    if (ref.startsWith(BRANCH_REF_PREFIX) && missing.length > 0) {
      const branchId = ref.slice(BRANCH_REF_PREFIX.length);
      const branch = db.getBranch(branchId);
      const head = db.getNodeByCommit(sha);
      if (branch && head && branch.headNodeId !== head.id)
        db.updateBranch(branchId, { headNodeId: head.id });
    }
  }

  const alive = opts.isProcessAlive ?? isProcessAlive;
  for (const agent of [
    ...db.listAgents({ status: "running" }),
    ...db.listAgents({ status: "starting" }),
  ]) {
    if (agent.pid === null || !alive(agent.pid)) {
      db.updateAgent(agent.id, { status: "failed", endedAt: new Date().toISOString() });
      const branch = db.getBranch(agent.branchId);
      if (branch?.status === "running") db.updateBranch(branch.id, { status: "failed" });
      report.failedAgents.push(agent.id);
    }
  }

  if (report.importedNodes.length || report.failedAgents.length) {
    db.appendEvent({
      actorType: "system",
      actorId: null,
      type: "reconcile",
      branchId: null,
      nodeId: null,
      agentId: null,
      payload: { ...report },
    });
  }
  return report;
}

async function importCommit(
  store: GitStore,
  db: TurtleDb,
  ref: string,
  commit: ParsedCommit,
  report: ReconcileReport,
): Promise<string | null> {
  const msg = parseNodeMessage(commit.message);
  const t = msg.trailers;
  const nodeId = t["Turtle-Node"];
  if (!nodeId) return null;
  const branchId =
    t["Turtle-Branch"] ??
    (ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : null);
  if (!branchId) return null;

  const parentNodes = commit.parents.map((p) => db.getNodeByCommit(p)).filter((n) => n !== null);
  const kind = pick(t["Turtle-Kind"], NODE_KINDS, parentNodes.length ? "micro" : "root");

  if (!db.getBranch(branchId)) {
    db.insertBranch({
      id: branchId,
      name: null,
      ref: `${BRANCH_REF_PREFIX}${branchId}`,
      rootNodeId: kind === "root" ? nodeId : (parentNodes[0]?.id ?? nodeId),
      forkedFromNodeId: null,
      headNodeId: null,
      workspacePath: null,
      status: "idle",
      createdAt: commit.date,
    });
    report.createdBranches.push(branchId);
  }

  const parentTree = parentNodes[0]?.treeSha ?? (await store.emptyTree());
  const stat = await store.diffStat(parentTree, commit.tree);
  const agentId = t["Turtle-Agent"] && db.getAgent(t["Turtle-Agent"]) ? t["Turtle-Agent"] : null;
  const summary = msg.body ? `${msg.title}\n\n${msg.body}` : msg.title;

  db.insertNode({
    id: nodeId,
    branchId,
    agentId,
    kind,
    parents: parentNodes.map((n) => n.id),
    commitSha: commit.sha,
    treeSha: commit.tree,
    intent: null,
    summary,
    summarySource: t["Turtle-Summary-Source"]
      ? pick(t["Turtle-Summary-Source"], SUMMARY_SOURCES, "rule_auto")
      : null,
    status: pick(t["Turtle-Status"], NODE_STATUSES, "progress"),
    trigger: t["Turtle-Trigger"] ?? "reconcile",
    sessionId: null,
    resumeToolUseId: null,
    resumeMessageUuid: null,
    tests: null,
    filesChanged: stat.filesChanged,
    linesAdded: stat.linesAdded,
    linesDeleted: stat.linesDeleted,
    tokens: { ...ZERO_TOKENS },
    costUsdEst: 0,
    tags: ["reconciled"],
    explorationGroupId: null,
    createdAt: commit.date,
  });
  return nodeId;
}

/**
 * Walk first-parent history from `tip`, newest first, one commit at a time so the caller
 * can stop early without git reading the user's whole history.
 */
async function* walk(store: GitStore, tip: string): AsyncGenerator<ParsedCommit> {
  let sha: string | undefined = tip;
  while (sha) {
    const raw = (
      await runGit(["cat-file", "commit", sha], { gitDir: store.commonDir })
    ).stdout.toString("utf8");
    const headerEnd = raw.indexOf("\n\n");
    const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
    const message = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
    let tree = "";
    let date = new Date(0).toISOString();
    const parents: string[] = [];
    for (const line of header.split("\n")) {
      if (line.startsWith("tree ")) tree = line.slice(5);
      else if (line.startsWith("parent ")) parents.push(line.slice(7));
      else if (line.startsWith("committer ")) {
        const m = / (\d+) [+-]\d{4}$/.exec(line);
        if (m) date = new Date(Number(m[1]) * 1000).toISOString();
      }
    }
    yield { sha, tree, parents, date, message };
    sha = parents[0];
  }
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
