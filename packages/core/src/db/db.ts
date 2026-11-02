import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { newId } from "../ids.js";
import { MIGRATIONS } from "./schema.js";
import type {
  Agent,
  Artifact,
  Branch,
  Snapshot,
  StoredMessage,
  TokenUsage,
  TurtleEvent,
  TurtleNode,
} from "./types.js";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

/** Typed access to turtle's SQLite database (docs/phase0-spec.md §7). */
export class TurtleDb {
  readonly raw: Database.Database;

  private constructor(raw: Database.Database) {
    this.raw = raw;
  }

  /** Open (creating if needed) and migrate. Use ":memory:" for tests. */
  static open(path: string): TurtleDb {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.pragma("busy_timeout = 5000");
    const db = new TurtleDb(raw);
    db.migrate();
    return db;
  }

  get schemaVersion(): number {
    return this.raw.pragma("user_version", { simple: true }) as number;
  }

  private migrate(): void {
    for (let v = this.schemaVersion; v < MIGRATIONS.length; v++) {
      this.raw.transaction(() => {
        this.raw.exec(MIGRATIONS[v] as string);
        this.raw.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  // ------------------------------------------------------------------ meta

  getMeta(key: string): string | null {
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | Row
      | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // -------------------------------------------------------------- branches

  insertBranch(b: Omit<Branch, "createdAt" | "updatedAt"> & { createdAt?: string }): Branch {
    const createdAt = b.createdAt ?? now();
    const branch: Branch = { ...b, createdAt, updatedAt: createdAt };
    this.raw
      .prepare(
        `INSERT INTO branches (id, name, ref, root_node_id, forked_from_node_id, head_node_id,
           workspace_path, status, created_at, updated_at)
         VALUES (@id, @name, @ref, @rootNodeId, @forkedFromNodeId, @headNodeId,
           @workspacePath, @status, @createdAt, @updatedAt)`,
      )
      .run(branch);
    return branch;
  }

  getBranch(id: string): Branch | null {
    const row = this.raw.prepare("SELECT * FROM branches WHERE id = ?").get(id) as Row | undefined;
    return row ? toBranch(row) : null;
  }

  listBranches(): Branch[] {
    return (this.raw.prepare("SELECT * FROM branches ORDER BY created_at").all() as Row[]).map(
      toBranch,
    );
  }

  updateBranch(
    id: string,
    patch: Partial<Pick<Branch, "name" | "headNodeId" | "workspacePath" | "status">>,
  ): void {
    const sets = Object.keys(patch).map((k) => `${snake(k)} = @${k}`);
    if (sets.length === 0) return;
    this.raw
      .prepare(`UPDATE branches SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`)
      .run({ ...patch, id, updatedAt: now() });
  }

  // ---------------------------------------------------------------- agents

  insertAgent(
    a: Omit<Agent, "startedAt" | "endedAt" | "totalCostUsd" | "numTurns"> & { startedAt?: string },
  ): Agent {
    const agent: Agent = {
      ...a,
      startedAt: a.startedAt ?? now(),
      endedAt: null,
      totalCostUsd: null,
      numTurns: null,
    };
    this.raw
      .prepare(
        `INSERT INTO agents (id, branch_id, adapter, adapter_level, model, sandbox, session_id, prompt,
           status, started_at, ended_at, total_cost_usd, num_turns, pid)
         VALUES (@id, @branchId, @adapter, @adapterLevel, @model, @sandbox, @sessionId, @prompt,
           @status, @startedAt, @endedAt, @totalCostUsd, @numTurns, @pid)`,
      )
      .run(agent);
    return agent;
  }

  getAgent(id: string): Agent | null {
    const row = this.raw.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  listAgents(filter: { status?: Agent["status"]; branchId?: string } = {}): Agent[] {
    const where: string[] = [];
    if (filter.status) where.push("status = @status");
    if (filter.branchId) where.push("branch_id = @branchId");
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at`;
    return (this.raw.prepare(sql).all(filter) as Row[]).map(toAgent);
  }

  updateAgent(
    id: string,
    patch: Partial<
      Pick<Agent, "sessionId" | "status" | "endedAt" | "totalCostUsd" | "numTurns" | "pid">
    >,
  ): void {
    const sets = Object.keys(patch).map((k) => `${snake(k)} = @${k}`);
    if (sets.length === 0) return;
    this.raw.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = @id`).run({ ...patch, id });
  }

  // ----------------------------------------------------------------- nodes

  insertNode(n: Omit<TurtleNode, "createdAt"> & { createdAt?: string }): TurtleNode {
    const node: TurtleNode = { ...n, createdAt: n.createdAt ?? now() };
    this.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO nodes (id, branch_id, agent_id, kind, commit_sha, tree_sha, intent, summary,
             summary_source, status, trigger, session_id, resume_tool_use_id, resume_message_uuid, tests,
             files_changed, lines_added, lines_deleted, tokens_input, tokens_cache_read,
             tokens_cache_write, tokens_output, cost_usd_est, tags, exploration_group_id, created_at)
           VALUES (@id, @branchId, @agentId, @kind, @commitSha, @treeSha, @intent, @summary,
             @summarySource, @status, @trigger, @sessionId, @resumeToolUseId, @resumeMessageUuid, @tests,
             @filesChanged, @linesAdded, @linesDeleted, @tokensInput, @tokensCacheRead,
             @tokensCacheWrite, @tokensOutput, @costUsdEst, @tagsJson, @explorationGroupId, @createdAt)`,
        )
        .run({
          ...node,
          tokensInput: node.tokens.input,
          tokensCacheRead: node.tokens.cacheRead,
          tokensCacheWrite: node.tokens.cacheWrite,
          tokensOutput: node.tokens.output,
          tagsJson: JSON.stringify(node.tags),
        });
      const insertParent = this.raw.prepare(
        "INSERT INTO node_parents (node_id, parent_id, ord) VALUES (?, ?, ?)",
      );
      node.parents.forEach((p, i) => {
        insertParent.run(node.id, p, i);
      });
    });
    return node;
  }

  getNode(id: string): TurtleNode | null {
    const row = this.raw.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
    return row ? this.withParents(row) : null;
  }

  getNodeByCommit(commitSha: string): TurtleNode | null {
    const row = this.raw
      .prepare("SELECT * FROM nodes WHERE commit_sha = ? LIMIT 1")
      .get(commitSha) as Row | undefined;
    return row ? this.withParents(row) : null;
  }

  /** Nodes whose id starts with `prefix` (used to resolve short ids typed by humans). */
  findNodesByPrefix(prefix: string, limit = 10): TurtleNode[] {
    const rows = this.raw
      .prepare("SELECT * FROM nodes WHERE id >= ? AND id < ? ORDER BY id LIMIT ?")
      .all(prefix, `${prefix}￿`, limit) as Row[];
    return rows.map((r) => this.withParents(r));
  }

  listNodes(filter: { branchId?: string; kinds?: TurtleNode["kind"][] } = {}): TurtleNode[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.branchId) {
      where.push("branch_id = ?");
      params.push(filter.branchId);
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }
    const sql = `SELECT * FROM nodes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, rowid`;
    return (this.raw.prepare(sql).all(...params) as Row[]).map((r) => this.withParents(r));
  }

  childrenOf(nodeId: string): TurtleNode[] {
    const rows = this.raw
      .prepare(
        `SELECT n.* FROM nodes n JOIN node_parents p ON p.node_id = n.id
         WHERE p.parent_id = ? ORDER BY n.created_at, n.rowid`,
      )
      .all(nodeId) as Row[];
    return rows.map((r) => this.withParents(r));
  }

  updateNode(
    id: string,
    patch: Partial<
      Pick<TurtleNode, "summary" | "summarySource" | "status" | "tests" | "resumeMessageUuid">
    > & {
      tags?: string[];
    },
  ): void {
    const params: Record<string, unknown> = { id };
    const sets: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "tags") {
        sets.push("tags = @tags");
        params.tags = JSON.stringify(v);
      } else {
        sets.push(`${snake(k)} = @${k}`);
        params[k] = v;
      }
    }
    if (sets.length === 0) return;
    this.raw.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  /**
   * Fill the resume point of nodes created by `toolUseId` once the message carrying its
   * tool_result has been seen (docs/phase0-spec.md §10). Returns the ids updated.
   */
  resolveResumePoint(agentId: string, toolUseId: string, messageUuid: string): string[] {
    const rows = this.raw
      .prepare(
        `SELECT id FROM nodes WHERE agent_id = ? AND resume_tool_use_id = ? AND resume_message_uuid IS NULL`,
      )
      .all(agentId, toolUseId) as Row[];
    const update = this.raw.prepare("UPDATE nodes SET resume_message_uuid = ? WHERE id = ?");
    for (const r of rows) update.run(messageUuid, r.id);
    return rows.map((r) => String(r.id));
  }

  private withParents(row: Row): TurtleNode {
    const parents = (
      this.raw
        .prepare("SELECT parent_id FROM node_parents WHERE node_id = ? ORDER BY ord")
        .all(row.id) as Row[]
    ).map((p) => String(p.parent_id));
    return toNode(row, parents);
  }

  // -------------------------------------------------------------- messages

  /** Append an SDK message verbatim; returns its sequence number within the agent. */
  appendMessage(
    agentId: string,
    m: {
      sessionId?: string | null;
      uuid?: string | null;
      type: string;
      parentToolUseId?: string | null;
      json: string;
    },
  ): number {
    const row = this.raw
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE agent_id = ?")
      .get(agentId) as Row;
    const seq = Number(row.next);
    this.raw
      .prepare(
        `INSERT INTO messages (agent_id, seq, session_id, uuid, type, parent_tool_use_id, node_id, json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        agentId,
        seq,
        m.sessionId ?? null,
        m.uuid ?? null,
        m.type,
        m.parentToolUseId ?? null,
        m.json,
      );
    return seq;
  }

  /** Assign all not-yet-attributed messages of an agent to `nodeId`. Returns how many. */
  attachPendingMessages(agentId: string, nodeId: string): number {
    return this.raw
      .prepare("UPDATE messages SET node_id = ? WHERE agent_id = ? AND node_id IS NULL")
      .run(nodeId, agentId).changes;
  }

  listMessages(
    agentId: string,
    filter: { afterSeq?: number; nodeId?: string } = {},
  ): StoredMessage[] {
    const where = ["agent_id = @agentId", "seq > @afterSeq"];
    if (filter.nodeId) where.push("node_id = @nodeId");
    const rows = this.raw
      .prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY seq`)
      .all({ agentId, afterSeq: filter.afterSeq ?? 0, nodeId: filter.nodeId }) as Row[];
    return rows.map(toMessage);
  }

  // ---------------------------------------------------------------- events

  appendEvent(e: Omit<TurtleEvent, "seq" | "id" | "at"> & { at?: string }): TurtleEvent {
    const event = { ...e, id: newId(), at: e.at ?? now() };
    const info = this.raw
      .prepare(
        `INSERT INTO events (id, at, actor_type, actor_id, type, branch_id, node_id, agent_id, payload)
         VALUES (@id, @at, @actorType, @actorId, @type, @branchId, @nodeId, @agentId, @payloadJson)`,
      )
      .run({ ...event, payloadJson: JSON.stringify(event.payload) });
    return { ...event, seq: Number(info.lastInsertRowid) };
  }

  listEvents(
    filter: { agentId?: string; branchId?: string; type?: string; afterSeq?: number } = {},
  ): TurtleEvent[] {
    const where = ["seq > @afterSeq"];
    if (filter.agentId) where.push("agent_id = @agentId");
    if (filter.branchId) where.push("branch_id = @branchId");
    if (filter.type) where.push("type = @type");
    const rows = this.raw
      .prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq`)
      .all({ ...filter, afterSeq: filter.afterSeq ?? 0 }) as Row[];
    return rows.map(toEvent);
  }

  // ------------------------------------------------------------- artifacts

  insertArtifact(a: Omit<Artifact, "id">): Artifact {
    const artifact: Artifact = { ...a, id: newId() };
    this.raw
      .prepare(
        `INSERT INTO artifacts (id, node_id, label, path, blob_sha, mime, size)
         VALUES (@id, @nodeId, @label, @path, @blobSha, @mime, @size)`,
      )
      .run(artifact);
    return artifact;
  }

  listArtifacts(nodeId: string): Artifact[] {
    return (
      this.raw
        .prepare("SELECT * FROM artifacts WHERE node_id = ? ORDER BY rowid")
        .all(nodeId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      nodeId: String(r.node_id),
      label: str(r.label),
      path: str(r.path),
      blobSha: String(r.blob_sha),
      mime: str(r.mime),
      size: num(r.size),
    }));
  }

  // ------------------------------------------------------------- snapshots

  putSnapshot(name: string, nodeId: string): Snapshot {
    const snap = { name, nodeId, createdAt: now() };
    this.raw
      .prepare(
        `INSERT INTO snapshots (name, node_id, created_at) VALUES (@name, @nodeId, @createdAt)
         ON CONFLICT(name) DO UPDATE SET node_id = excluded.node_id, created_at = excluded.created_at`,
      )
      .run(snap);
    return snap;
  }

  getSnapshot(name: string): Snapshot | null {
    const r = this.raw.prepare("SELECT * FROM snapshots WHERE name = ?").get(name) as
      | Row
      | undefined;
    return r
      ? { name: String(r.name), nodeId: String(r.node_id), createdAt: String(r.created_at) }
      : null;
  }

  listSnapshots(): Snapshot[] {
    return (this.raw.prepare("SELECT * FROM snapshots ORDER BY name").all() as Row[]).map((r) => ({
      name: String(r.name),
      nodeId: String(r.node_id),
      createdAt: String(r.created_at),
    }));
  }

  deleteSnapshot(name: string): void {
    this.raw.prepare("DELETE FROM snapshots WHERE name = ?").run(name);
  }
}

// ------------------------------------------------------------------ mapping

function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toBranch(r: Row): Branch {
  return {
    id: String(r.id),
    name: str(r.name),
    ref: String(r.ref),
    rootNodeId: String(r.root_node_id),
    forkedFromNodeId: str(r.forked_from_node_id),
    headNodeId: str(r.head_node_id),
    workspacePath: str(r.workspace_path),
    status: r.status as Branch["status"],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toAgent(r: Row): Agent {
  return {
    id: String(r.id),
    branchId: String(r.branch_id),
    adapter: String(r.adapter),
    adapterLevel: Number(r.adapter_level) as Agent["adapterLevel"],
    model: str(r.model),
    sandbox: r.sandbox as Agent["sandbox"],
    sessionId: str(r.session_id),
    prompt: String(r.prompt),
    status: r.status as Agent["status"],
    startedAt: String(r.started_at),
    endedAt: str(r.ended_at),
    totalCostUsd: num(r.total_cost_usd),
    numTurns: num(r.num_turns),
    pid: num(r.pid),
  };
}

function toNode(r: Row, parents: string[]): TurtleNode {
  const tokens: TokenUsage = {
    input: Number(r.tokens_input),
    cacheRead: Number(r.tokens_cache_read),
    cacheWrite: Number(r.tokens_cache_write),
    output: Number(r.tokens_output),
  };
  return {
    id: String(r.id),
    branchId: String(r.branch_id),
    agentId: str(r.agent_id),
    kind: r.kind as TurtleNode["kind"],
    parents,
    commitSha: String(r.commit_sha),
    treeSha: String(r.tree_sha),
    intent: str(r.intent),
    summary: str(r.summary),
    summarySource: str(r.summary_source) as TurtleNode["summarySource"],
    status: r.status as TurtleNode["status"],
    trigger: str(r.trigger),
    sessionId: str(r.session_id),
    resumeToolUseId: str(r.resume_tool_use_id),
    resumeMessageUuid: str(r.resume_message_uuid),
    tests: str(r.tests) as TurtleNode["tests"],
    filesChanged: num(r.files_changed),
    linesAdded: num(r.lines_added),
    linesDeleted: num(r.lines_deleted),
    tokens,
    costUsdEst: Number(r.cost_usd_est),
    tags: JSON.parse(String(r.tags)) as string[],
    explorationGroupId: str(r.exploration_group_id),
    createdAt: String(r.created_at),
  };
}

function toMessage(r: Row): StoredMessage {
  return {
    agentId: String(r.agent_id),
    seq: Number(r.seq),
    sessionId: str(r.session_id),
    uuid: str(r.uuid),
    type: String(r.type),
    parentToolUseId: str(r.parent_tool_use_id),
    nodeId: str(r.node_id),
    json: String(r.json),
  };
}

function toEvent(r: Row): TurtleEvent {
  return {
    seq: Number(r.seq),
    id: String(r.id),
    at: String(r.at),
    actorType: r.actor_type as TurtleEvent["actorType"],
    actorId: str(r.actor_id),
    type: String(r.type),
    branchId: str(r.branch_id),
    nodeId: str(r.node_id),
    agentId: str(r.agent_id),
    payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
  };
}
