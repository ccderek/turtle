import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Actor,
  Change,
  Concept,
  ConceptField,
  ConceptFields,
  ConceptKind,
  Link,
  LinkRel,
  LinkTarget,
  Operation,
} from "./types.js";

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ops (
  id      TEXT PRIMARY KEY,
  replica TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  deps    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  at      TEXT NOT NULL,
  change  TEXT NOT NULL,
  batch   TEXT NOT NULL,
  -- values a set/drop replaced, so the operation can be undone
  prev    TEXT,
  ord     INTEGER NOT NULL,
  UNIQUE (replica, seq)
);
CREATE INDEX IF NOT EXISTS ops_batch ON ops(batch);
CREATE TABLE IF NOT EXISTS concepts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  parent_id  TEXT,
  status     TEXT,
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  dropped    INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  field_meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS concepts_parent ON concepts(parent_id);
CREATE INDEX IF NOT EXISTS concepts_kind ON concepts(kind, status);
CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  rel        TEXT NOT NULL,
  to_type    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS links_to ON links(to_type, to_id);
`;

const COLUMN_FIELDS = new Set(["kind", "parentId", "status"]);

/**
 * The task graph's SQLite view (docs/phase2-spec.md §5). It is a cache: every row can
 * be rebuilt by replaying the operation log, so `apply` must be deterministic.
 */
export class GraphDb {
  readonly raw: Database.Database;

  private constructor(raw: Database.Database) {
    this.raw = raw;
  }

  static open(path: string): GraphDb {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.pragma("busy_timeout = 5000");
    raw.exec(SCHEMA);
    return new GraphDb(raw);
  }

  /** False once closed (e.g. while a server shuts down and runs are still ending). */
  get isOpen(): boolean {
    return this.raw.open;
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  /** Changes whenever any connection commits (live views poll it). */
  changeToken(): string {
    const dataVersion = this.raw.pragma("data_version", { simple: true });
    const own = (this.raw.prepare("SELECT total_changes() AS n").get() as Row).n;
    return `${dataVersion}:${own}`;
  }

  getMeta(key: string): string | null {
    const r = this.raw.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Wipe the view (before a rebuild). */
  clear(): void {
    this.raw.exec("DELETE FROM ops; DELETE FROM concepts; DELETE FROM links; DELETE FROM meta;");
  }

  // ---------------------------------------------------------------- ops

  maxSeq(replica: string): number {
    const r = this.raw
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM ops WHERE replica = ?")
      .get(replica) as Row;
    return Number(r.s);
  }

  /** Version vector of everything applied: highest seq per replica. */
  versionVector(): Record<string, number> {
    const rows = this.raw
      .prepare("SELECT replica, MAX(seq) AS s FROM ops GROUP BY replica")
      .all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.replica), Number(r.s)]));
  }

  /** Position of the latest operation in the view (a cursor for deltas). */
  maxOrd(): number {
    return Number((this.raw.prepare("SELECT COALESCE(MAX(ord), 0) AS n FROM ops").get() as Row).n);
  }

  /** Concept and link ids touched by operations after `ord`. */
  touchedSince(ord: number): { concepts: string[]; links: string[] } {
    const rows = this.raw
      .prepare("SELECT change FROM ops WHERE ord > ? ORDER BY ord")
      .all(ord) as Row[];
    const concepts = new Set<string>();
    const links = new Set<string>();
    for (const r of rows) {
      const c = JSON.parse(String(r.change)) as Change;
      if (c.kind === "link" || c.kind === "unlink") {
        links.add(c.id);
        if (c.kind === "link") concepts.add(c.from);
      } else concepts.add(c.id);
    }
    return { concepts: [...concepts], links: [...links] };
  }

  getLink(id: string): Link | null {
    return this.listLinks({ includeRemoved: true }).find((l) => l.id === id) ?? null;
  }

  hasOp(id: string): boolean {
    return Boolean(this.raw.prepare("SELECT 1 FROM ops WHERE id = ?").get(id));
  }

  getOp(id: string): (Operation & { batch: string; prev: unknown }) | null {
    const r = this.raw.prepare("SELECT * FROM ops WHERE id = ?").get(id) as Row | undefined;
    return r ? toOp(r) : null;
  }

  listOps(
    filter: { batch?: string; concept?: string } = {},
  ): (Operation & { batch: string; prev: unknown })[] {
    let rows: Row[];
    if (filter.batch)
      rows = this.raw
        .prepare("SELECT * FROM ops WHERE batch = ? ORDER BY ord")
        .all(filter.batch) as Row[];
    else if (filter.concept)
      rows = this.raw
        .prepare(
          "SELECT * FROM ops WHERE json_extract(change, '$.id') = ? OR json_extract(change, '$.from') = ? ORDER BY ord",
        )
        .all(filter.concept, filter.concept) as Row[];
    else rows = this.raw.prepare("SELECT * FROM ops ORDER BY ord").all() as Row[];
    return rows.map(toOp);
  }

  /**
   * Record an operation and apply it to the view. Idempotent: an operation that is
   * already present is skipped (replays and repeated imports are safe).
   */
  applyOp(op: Operation, batch: string): void {
    if (this.hasOp(op.id)) return;
    const prev = this.applyChange(op);
    const ord = Number(
      (this.raw.prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM ops").get() as Row).n,
    );
    this.raw
      .prepare(
        "INSERT INTO ops (id, replica, seq, deps, actor, at, change, batch, prev, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        op.id,
        op.replica,
        op.seq,
        JSON.stringify(op.deps),
        JSON.stringify(op.actor),
        op.at,
        JSON.stringify(op.change),
        batch,
        prev === undefined ? null : JSON.stringify(prev),
        ord,
      );
  }

  /** Returns the values replaced (for undo). */
  private applyChange(op: Operation): unknown {
    const c = op.change;
    switch (c.kind) {
      case "create": {
        if (this.getConcept(c.id)) return undefined;
        const meta: Concept["fieldMeta"] = {};
        for (const k of Object.keys(c.fields)) {
          if (k !== "kind") meta[k as ConceptField] = { v: 1, by: op.actor };
        }
        this.writeConcept({
          ...c.fields,
          id: c.id,
          version: 1,
          dropped: false,
          createdBy: op.actor,
          createdAt: op.at,
          updatedAt: op.at,
          fieldMeta: meta,
        });
        return undefined;
      }
      case "set": {
        const cur = this.getConcept(c.id);
        if (!cur) return undefined;
        const prev: Record<string, unknown> = {};
        const next: Concept = {
          ...cur,
          version: cur.version + 1,
          updatedAt: op.at,
          fieldMeta: { ...cur.fieldMeta },
        };
        for (const [k, v] of Object.entries(c.fields)) {
          prev[k] = (cur as unknown as Record<string, unknown>)[k] ?? null;
          (next as unknown as Record<string, unknown>)[k] = v;
          next.fieldMeta[k as ConceptField] = { v: next.version, by: op.actor };
        }
        this.writeConcept(next);
        return prev;
      }
      case "drop":
      case "restore": {
        const cur = this.getConcept(c.id);
        if (!cur) return undefined;
        this.writeConcept({
          ...cur,
          dropped: c.kind === "drop",
          version: cur.version + 1,
          updatedAt: op.at,
        });
        return { dropped: cur.dropped };
      }
      case "link": {
        this.raw
          .prepare(
            `INSERT OR IGNORE INTO links (id, from_id, rel, to_type, to_id, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(c.id, c.from, c.rel, c.to.type, c.to.id, JSON.stringify(op.actor), op.at);
        return undefined;
      }
      case "unlink": {
        this.raw.prepare("UPDATE links SET removed = 1 WHERE id = ?").run(c.id);
        return undefined;
      }
    }
  }

  // ----------------------------------------------------------- concepts

  private writeConcept(c: Concept): void {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (
        ["id", "version", "dropped", "createdBy", "createdAt", "updatedAt", "fieldMeta"].includes(k)
      )
        continue;
      if (COLUMN_FIELDS.has(k)) continue;
      if (v !== undefined) data[k] = v;
    }
    this.raw
      .prepare(
        `INSERT INTO concepts (id, kind, parent_id, status, data, version, dropped, created_by, created_at, updated_at, field_meta)
         VALUES (@id, @kind, @parentId, @status, @data, @version, @dropped, @createdBy, @createdAt, @updatedAt, @fieldMeta)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, parent_id = excluded.parent_id, status = excluded.status,
           data = excluded.data, version = excluded.version, dropped = excluded.dropped,
           updated_at = excluded.updated_at, field_meta = excluded.field_meta`,
      )
      .run({
        id: c.id,
        kind: c.kind,
        parentId: c.parentId ?? null,
        status: c.status ?? null,
        data: JSON.stringify(data),
        version: c.version,
        dropped: c.dropped ? 1 : 0,
        createdBy: JSON.stringify(c.createdBy),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        fieldMeta: JSON.stringify(c.fieldMeta),
      });
  }

  getConcept(id: string): Concept | null {
    const r = this.raw.prepare("SELECT * FROM concepts WHERE id = ?").get(id) as Row | undefined;
    return r ? toConcept(r) : null;
  }

  findConceptsByPrefix(prefix: string, limit = 10): Concept[] {
    return (
      this.raw
        .prepare("SELECT * FROM concepts WHERE id LIKE ? ORDER BY id LIMIT ?")
        .all(`${prefix}%`, limit) as Row[]
    ).map(toConcept);
  }

  listConcepts(
    filter: { kind?: ConceptKind; parentId?: string | null; includeDropped?: boolean } = {},
  ): Concept[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.kind) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.parentId !== undefined) {
      where.push(filter.parentId === null ? "parent_id IS NULL" : "parent_id = ?");
      if (filter.parentId !== null) args.push(filter.parentId);
    }
    if (!filter.includeDropped) where.push("dropped = 0");
    const sql = `SELECT * FROM concepts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.raw.prepare(sql).all(...args) as Row[]).map(toConcept);
  }

  // -------------------------------------------------------------- links

  listLinks(
    filter: { from?: string; to?: LinkTarget; rel?: LinkRel; includeRemoved?: boolean } = {},
  ): Link[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.from) {
      where.push("from_id = ?");
      args.push(filter.from);
    }
    if (filter.to) {
      where.push("to_type = ? AND to_id = ?");
      args.push(filter.to.type, filter.to.id);
    }
    if (filter.rel) {
      where.push("rel = ?");
      args.push(filter.rel);
    }
    if (!filter.includeRemoved) where.push("removed = 0");
    const sql = `SELECT * FROM links ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.raw.prepare(sql).all(...args) as Row[]).map((r) => ({
      id: String(r.id),
      from: String(r.from_id),
      rel: String(r.rel) as LinkRel,
      to: { type: String(r.to_type) as LinkTarget["type"], id: String(r.to_id) },
      createdBy: JSON.parse(String(r.created_by)) as Actor,
      createdAt: String(r.created_at),
      removed: Number(r.removed) === 1,
    }));
  }

  /** A stable, comparable dump of the view (tests: replay must reproduce it exactly). */
  snapshot(): { concepts: Concept[]; links: Link[] } {
    return {
      concepts: this.listConcepts({ includeDropped: true }).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      links: this.listLinks({ includeRemoved: true }).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
}

function toConcept(r: Row): Concept {
  const data = JSON.parse(String(r.data)) as Partial<ConceptFields>;
  const c: Concept = {
    ...data,
    id: String(r.id),
    kind: String(r.kind) as ConceptKind,
    parentId: r.parent_id === null ? null : String(r.parent_id),
    title: data.title ?? "",
    version: Number(r.version),
    dropped: Number(r.dropped) === 1,
    createdBy: JSON.parse(String(r.created_by)) as Actor,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    fieldMeta: JSON.parse(String(r.field_meta)),
  };
  if (r.status !== null) c.status = String(r.status) as Concept["status"];
  return c;
}

function toOp(r: Row): Operation & { batch: string; prev: unknown } {
  return {
    id: String(r.id),
    replica: String(r.replica),
    seq: Number(r.seq),
    deps: JSON.parse(String(r.deps)) as Record<string, number>,
    actor: JSON.parse(String(r.actor)) as Actor,
    at: String(r.at),
    change: JSON.parse(String(r.change)) as Change,
    batch: String(r.batch),
    prev: r.prev === null ? undefined : JSON.parse(String(r.prev)),
  };
}
