import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TurtleDb } from "../db/db.js";
import type { Branch, BranchStatus, NodeKind, NodeStatus, TurtleNode } from "../db/types.js";
import { AGENT_IDENTITY, BRANCH_REF_PREFIX, type DiffStat, type GitStore } from "../git/store.js";
import { newId } from "../ids.js";

/**
 * One more source repository in a multi-source run (docs/phase2-spec.md §7.1).
 * The run's primary source keeps the conversation, resume points and summaries; each
 * companion is snapshotted alongside it into its own branch, and every companion node
 * carries `Turtle-Checkpoint: <primary node id>`.
 */
export interface SourceHandle {
  id: string;
  store: GitStore;
  db: TurtleDb;
}

export interface CheckpointPart {
  source: string;
  nodeId: string;
  commit: string;
  tree: string;
}

interface Head {
  nodeId: string;
  commit: string;
  tree: string;
}

export class Companion {
  private head!: Head;
  private semanticTree!: string;
  branch!: Branch;

  private constructor(
    readonly source: SourceHandle,
    readonly workTree: string,
    private readonly agentId: string,
  ) {}

  get id(): string {
    return this.source.id;
  }

  get headPart(): CheckpointPart {
    return {
      source: this.id,
      nodeId: this.head.nodeId,
      commit: this.head.commit,
      tree: this.head.tree,
    };
  }

  /**
   * Open the companion's branch: a new one from its working copy, the given branch to
   * continue, or a new branch forked from `fromNodeId`.
   */
  static async start(
    source: SourceHandle,
    o: {
      root: string;
      agentId: string;
      prompt: string;
      sandbox: "none" | "docker";
      fromHead?: boolean;
      continueBranchId?: string | null;
      fromNodeId?: string | null;
      checkpointId: string;
    },
  ): Promise<Companion> {
    const { store, db } = source;
    const workTree = join(o.root, source.id);
    const c = new Companion(source, workTree, o.agentId);
    const existing = o.continueBranchId ? db.getBranch(o.continueBranchId) : null;
    if (existing?.headNodeId) {
      const head = db.getNode(existing.headNodeId) as TurtleNode;
      c.branch = existing;
      c.setHead(head);
      // A kept workspace is reused as it is, like the primary's (gc removes finished ones).
      if (!existsSync(workTree))
        await store.materialize(head.commitSha, workTree, store.indexFileFor(existing.id));
      db.updateBranch(existing.id, { status: "running", workspacePath: workTree });
    } else if (o.fromNodeId && db.getNode(o.fromNodeId)) {
      const from = db.getNode(o.fromNodeId) as TurtleNode;
      const branchId = newId();
      const ref = `${BRANCH_REF_PREFIX}${branchId}`;
      c.branch = db.insertBranch({
        id: branchId,
        name: null,
        ref,
        rootNodeId: from.id,
        forkedFromNodeId: from.id,
        headNodeId: from.id,
        workspacePath: workTree,
        status: "running",
      });
      await store.updateRef(ref, from.commitSha, null);
      c.setHead(from);
      await store.materialize(from.commitSha, workTree, store.indexFileFor(branchId));
    } else {
      const branchId = newId();
      const rootId = newId();
      const ref = `${BRANCH_REF_PREFIX}${branchId}`;
      const root = await store.snapshotWorkingCopy({
        indexFile: join(store.turtleDir, "index", `root-${branchId}`),
        message: {
          title: "root",
          trailers: {
            "Turtle-Node": rootId,
            "Turtle-Kind": "root",
            "Turtle-Status": "done",
            "Turtle-Branch": branchId,
            "Turtle-Checkpoint": o.checkpointId,
          },
        },
        identity: await store.userIdentity(),
        fromHead: o.fromHead ?? false,
      });
      c.branch = db.transaction(() => {
        const b = db.insertBranch({
          id: branchId,
          name: null,
          ref,
          rootNodeId: rootId,
          forkedFromNodeId: null,
          headNodeId: rootId,
          workspacePath: workTree,
          status: "running",
        });
        db.insertNode(
          companionNode({
            id: rootId,
            branchId,
            agentId: null,
            kind: "root",
            parents: [],
            commitSha: root.commit,
            treeSha: root.tree,
            summary: `root: HEAD ${root.head ? root.head.slice(0, 7) : "(no commits)"}${root.dirty ? " + uncommitted changes" : ""}`,
            status: "done",
            trigger: "root",
            tags: [`checkpoint:${o.checkpointId}`],
          }),
        );
        return b;
      });
      await store.updateRef(ref, root.commit, null);
      c.setHead(db.getNode(rootId) as TurtleNode);
      await store.materialize(root.commit, workTree, store.indexFileFor(branchId));
    }
    // An agent row with this process's pid marks the branch as having a live writer,
    // so a reconcile in another process leaves it alone (phase1-spec §3.1).
    db.insertAgent({
      id: o.agentId,
      branchId: c.branch.id,
      adapter: "companion",
      adapterLevel: 2,
      model: null,
      sandbox: o.sandbox,
      sessionId: null,
      prompt: o.prompt,
      status: "running",
      pid: process.pid,
    });
    return c;
  }

  private setHead(n: TurtleNode): void {
    this.head = { nodeId: n.id, commit: n.commitSha, tree: n.treeSha };
    this.semanticTree = lastSemanticTree(this.source.db, n);
  }

  /** Changes since the last checkpoint (rules and summaries combine all sources). */
  statSinceCheckpoint(): Promise<DiffStat> {
    return this.source.store.diffStat(this.semanticTree, this.head.tree);
  }

  get checkpointTree(): string {
    return this.semanticTree;
  }

  get headTree(): string {
    return this.head.tree;
  }

  /** Tree the companion's branch started from. */
  get rootTree(): string {
    return this.source.db.getNode(this.branch.rootNodeId)?.treeSha ?? this.head.tree;
  }

  /** Snapshot alongside a primary node. Returns null when nothing changed and unchanged trees are not wanted. */
  async snapshot(p: {
    checkpointId: string;
    kind: NodeKind;
    title: string;
    body?: string;
    status: NodeStatus;
    trigger: string;
    allowUnchanged: boolean;
  }): Promise<{ part: CheckpointPart; stat: DiffStat } | null> {
    const { store, db } = this.source;
    const id = newId();
    const res = await store.snapshot({
      workTree: this.workTree,
      indexFile: store.indexFileFor(this.branch.id),
      parent: { commit: this.head.commit, tree: this.head.tree },
      message: {
        title: p.title,
        ...(p.body ? { body: p.body } : {}),
        trailers: {
          "Turtle-Node": id,
          "Turtle-Kind": p.kind,
          "Turtle-Status": p.status,
          "Turtle-Branch": this.branch.id,
          "Turtle-Agent": this.agentId,
          "Turtle-Trigger": p.trigger,
          "Turtle-Checkpoint": p.checkpointId,
        },
      },
      identity: AGENT_IDENTITY,
      allowUnchanged: p.allowUnchanged,
      ref: { name: this.branch.ref, expectedOld: this.head.commit },
    });
    if (!res) return null;
    const stat =
      p.kind === "semantic" ? await store.diffStat(this.semanticTree, res.tree) : res.stat;
    db.transaction(() => {
      db.insertNode(
        companionNode({
          id,
          branchId: this.branch.id,
          agentId: this.agentId,
          kind: p.kind,
          parents: [this.head.nodeId],
          commitSha: res.commit,
          treeSha: res.tree,
          summary: p.body ? `${p.title}\n\n${p.body}` : p.title,
          status: p.status,
          trigger: p.trigger,
          filesChanged: stat.filesChanged,
          linesAdded: stat.linesAdded,
          linesDeleted: stat.linesDeleted,
          tags: [`checkpoint:${p.checkpointId}`],
        }),
      );
      db.updateBranch(this.branch.id, { headNodeId: id });
    });
    this.head = { nodeId: id, commit: res.commit, tree: res.tree };
    if (p.kind === "semantic") this.semanticTree = res.tree;
    return { part: { source: this.id, nodeId: id, commit: res.commit, tree: res.tree }, stat };
  }

  finish(status: BranchStatus, agentStatus: "done" | "killed" | "failed"): void {
    const { db } = this.source;
    db.updateAgent(this.agentId, { status: agentStatus, endedAt: new Date().toISOString() });
    db.updateBranch(this.branch.id, { status });
  }
}

function lastSemanticTree(db: TurtleDb, node: TurtleNode): string {
  let cur: TurtleNode | null = node;
  while (cur) {
    if (cur.kind === "semantic" || cur.kind === "root" || cur.parents.length === 0)
      return cur.treeSha;
    cur = cur.parents[0] ? db.getNode(cur.parents[0]) : null;
  }
  return node.treeSha;
}

function companionNode(
  n: Pick<
    TurtleNode,
    | "id"
    | "branchId"
    | "agentId"
    | "kind"
    | "parents"
    | "commitSha"
    | "treeSha"
    | "summary"
    | "status"
    | "trigger"
    | "tags"
  > &
    Partial<TurtleNode>,
): Omit<TurtleNode, "createdAt"> {
  return {
    intent: null,
    summarySource: null,
    sessionId: null,
    resumeToolUseId: null,
    resumeMessageUuid: null,
    tests: null,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    costUsdEst: 0,
    explorationGroupId: null,
    ...n,
  };
}

/**
 * The full multi-source state at a primary node: for each companion, the nearest part
 * recorded at or before that node (micro checkpoints only record changed sources).
 */
export function resolveCheckpointParts(
  primaryDb: TurtleDb,
  nodeId: string,
): Map<string, CheckpointPart> {
  const byNode = new Map<string, CheckpointPart[]>();
  for (const e of primaryDb.listEvents()) {
    const list = e.payload.parts as CheckpointPart[] | undefined;
    if (!e.nodeId || !list?.length) continue;
    // Later events win (a continue re-records the same head).
    byNode.set(e.nodeId, [...list, ...(byNode.get(e.nodeId) ?? [])]);
  }
  const parts = new Map<string, CheckpointPart>();
  let cur = primaryDb.getNode(nodeId);
  while (cur) {
    for (const p of byNode.get(cur.id) ?? []) if (!parts.has(p.source)) parts.set(p.source, p);
    cur = cur.parents[0] ? primaryDb.getNode(cur.parents[0]) : null;
  }
  return parts;
}

/** Companion branches of a primary branch, from its latest run that recorded them. */
export function companionBranches(primaryDb: TurtleDb, branchId: string): Map<string, string> {
  const out = new Map<string, string>();
  const events = primaryDb
    .listEvents({ branchId })
    .filter((e) => e.type === "run_start" || e.type === "fork")
    .reverse();
  for (const e of events) {
    for (const c of (e.payload.companions ?? []) as { source: string; branchId: string }[]) {
      if (!out.has(c.source)) out.set(c.source, c.branchId);
    }
  }
  return out;
}
