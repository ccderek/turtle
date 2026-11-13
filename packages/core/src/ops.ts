import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurtleDb } from "./db/db.js";
import type { ActorType, Branch, TurtleNode } from "./db/types.js";
import { runGit } from "./git/exec.js";
import { type GitStore, SNAPSHOT_REF_PREFIX } from "./git/store.js";

/**
 * Operations shared by the CLI and the web server (docs/phase1-spec.md §4). They throw
 * `OpsError` for problems the human can fix (bad name, nothing running, …).
 */
/** Thrown when what was asked for does not exist (HTTP 404 in the server). */
export class NotFoundError extends Error {}

export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsError";
  }
}

const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0] ?? "";

// ------------------------------------------------------------- navigation

/** The node itself if it is not a micro snapshot, else its nearest non-micro ancestor. */
export function checkpointOf(db: TurtleDb, node: TurtleNode | null): TurtleNode | null {
  let n = node;
  while (n && n.kind === "micro") n = n.parents[0] ? db.getNode(n.parents[0]) : null;
  return n;
}

/**
 * What a node's changes are measured against: semantic nodes against the previous
 * checkpoint (skipping micro snapshots), everything else against its parent.
 */
export function diffBaseOf(db: TurtleDb, n: TurtleNode): TurtleNode | null {
  const parent = n.parents[0] ? db.getNode(n.parents[0]) : null;
  return n.kind === "semantic" ? checkpointOf(db, parent) : parent;
}

/** Ids of the nodes whose messages led to `n`: n and the micro snapshots right before it. */
export function stepNodeIds(db: TurtleDb, n: TurtleNode): string[] {
  const ids = [n.id];
  if (n.kind === "micro") return ids;
  let cur = n.parents[0] ? db.getNode(n.parents[0]) : null;
  while (cur && cur.kind === "micro" && cur.branchId === n.branchId) {
    ids.push(cur.id);
    cur = cur.parents[0] ? db.getNode(cur.parents[0]) : null;
  }
  return ids;
}

// -------------------------------------------------------------------- tag

export async function tagNode(
  store: GitStore,
  db: TurtleDb,
  n: TurtleNode,
  name: string,
  actor: ActorType = "human",
): Promise<{ moved: boolean }> {
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".") || name.includes(".."))
    throw new OpsError(`invalid snapshot name: ${name}`);
  const refName = `${SNAPSHOT_REF_PREFIX}${name}`;
  const old = await store.readRef(refName);
  await store.updateRef(refName, n.commitSha, old);
  db.transaction(() => {
    db.putSnapshot(name, n.id);
    const tags = n.tags.includes("snapshot") ? n.tags : [...n.tags, "snapshot"];
    db.updateNode(n.id, { tags });
    db.appendEvent({
      actorType: actor,
      actorId: null,
      type: "tag",
      branchId: n.branchId,
      nodeId: n.id,
      agentId: null,
      payload: { name, moved: Boolean(old) },
    });
  });
  return { moved: Boolean(old) };
}

// ----------------------------------------------------------------- export

/** Semantic nodes from the original root to `n`, oldest first (crossing fork points). */
export function semanticPath(
  db: TurtleDb,
  n: TurtleNode,
): { path: TurtleNode[]; root: TurtleNode } {
  const path: TurtleNode[] = [];
  let cur: TurtleNode | null = n;
  let root: TurtleNode = n;
  while (cur) {
    if (cur.kind === "semantic") path.push(cur);
    root = cur;
    cur = cur.parents[0] ? db.getNode(cur.parents[0]) : null;
  }
  return { path: path.reverse(), root };
}

export interface ExportResult {
  branch: string;
  commit: string;
  base: string | null;
  /** The run started from uncommitted changes, which are part of the commit. */
  includesUncommitted: boolean;
}

/** Create `refs/heads/<branch>` with one commit holding the node's files, on the run's HEAD. */
export async function exportNode(
  store: GitStore,
  db: TurtleDb,
  n: TurtleNode,
  o: { branch: string; message?: string },
): Promise<ExportResult> {
  const branchRef = `refs/heads/${o.branch}`;
  const check = await runGit(["check-ref-format", branchRef], { okCodes: [0, 1] });
  if (!o.branch || check.exitCode !== 0) throw new OpsError(`invalid branch name: ${o.branch}`);
  if (await store.readRef(branchRef)) throw new OpsError(`branch ${o.branch} already exists`);

  const { path, root } = semanticPath(db, n);
  const rootCommit = await store.readCommit(root.commitSha);
  const base = rootCommit.parents[0] ?? null;
  const title = o.message || firstLine(n.summary) || "turtle export";
  const body = path.map((p) => `- ${firstLine(p.summary)}`).join("\n");
  const message = `${title}\n\n${body ? `${body}\n\n` : ""}Turtle-Export: ${n.id}\n`;
  const identity = await store.userIdentity();
  const commit = await store.commitTree(n.treeSha, base ? [base] : [], message, identity);
  await store.updateRef(branchRef, commit, null);
  db.appendEvent({
    actorType: "human",
    actorId: null,
    type: "export",
    branchId: n.branchId,
    nodeId: n.id,
    agentId: null,
    payload: { branch: o.branch, commit },
  });
  return {
    branch: o.branch,
    commit,
    base,
    includesUncommitted: Boolean(root.summary?.includes("uncommitted")),
  };
}

// ------------------------------------------------------------------- stop

/**
 * Who owns a running agent. `turtle run` writes `run/<agent>.pid` (stopped with SIGINT);
 * `turtle ui` writes `run/<agent>.ui` and polls the events table for `stop_request`
 * (docs/phase1-spec.md §4.3).
 */
export function pidFileFor(store: GitStore, agentId: string): string {
  return join(store.turtleDir, "run", `${agentId}.pid`);
}

export function uiOwnerFileFor(store: GitStore, agentId: string): string {
  return join(store.turtleDir, "run", `${agentId}.ui`);
}

export interface StopResult {
  agentId: string;
  via: "signal" | "request" | "none";
  detail: string;
}

/** Ask every running agent on a branch to stop at its next tool boundary. */
export async function requestStop(
  store: GitStore,
  db: TurtleDb,
  branch: Branch,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): Promise<StopResult[]> {
  const agents = [
    ...db.listAgents({ branchId: branch.id, status: "running" }),
    ...db.listAgents({ branchId: branch.id, status: "starting" }),
  ];
  if (!agents.length) throw new OpsError(`branch ${branch.id} has no running agent`);
  const out: StopResult[] = [];
  for (const a of agents) {
    const pidFile = pidFileFor(store, a.id);
    if (existsSync(pidFile)) {
      const pid = Number(await readFile(pidFile, "utf8"));
      try {
        kill(pid, "SIGINT");
        out.push({ agentId: a.id, via: "signal", detail: `interrupt sent (pid ${pid})` });
      } catch (err) {
        out.push({
          agentId: a.id,
          via: "none",
          detail: `could not signal pid ${pid}: ${(err as Error).message}`,
        });
      }
    } else if (existsSync(uiOwnerFileFor(store, a.id)) || (a.pid !== null && isAlive(a.pid))) {
      db.appendEvent({
        actorType: "human",
        actorId: null,
        type: "stop_request",
        branchId: branch.id,
        nodeId: null,
        agentId: a.id,
        payload: {},
      });
      out.push({
        agentId: a.id,
        via: "request",
        detail: "stop requested; the agent stops at its next tool boundary",
      });
    } else {
      out.push({
        agentId: a.id,
        via: "none",
        detail: "no owning process found (it may have crashed; `turtle doctor` cleans up)",
      });
    }
  }
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
