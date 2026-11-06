import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { runGit } from "../git/exec.js";
import type { GitStore } from "../git/store.js";
import type { GraphDb } from "./graph-db.js";
import type { Actor, Change, Operation } from "./types.js";

export const OPS_REF_PREFIX = "refs/turtle/ops/";
const OPS_FILE = "ops.jsonl";

/** JSON with sorted object keys, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function operationId(op: Omit<Operation, "id">): string {
  return createHash("sha256").update(canonicalJson(op)).digest("hex").slice(0, 32);
}

/**
 * Exclusive lock shared by every process writing one replica (UI, CLI, agents):
 * a file created with O_EXCL holding the owner's pid. A lock whose owner is gone, or
 * that is older than `staleMs`, is broken.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  staleMs = 30_000,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await isStale(path, staleMs)) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const pid = Number(text);
    if (Date.now() - st.mtimeMs > staleMs) return true;
    if (!pid) return false; // being written right now
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

export interface OpLogOptions {
  store: GitStore;
  db: GraphDb;
  replica: string;
  lockFile: string;
  /** Committer identity for op commits (never the user's email). */
  committer: { name: string; email: string };
  now?: () => Date;
}

/**
 * The operation log (docs/phase2-spec.md §5): batches of operations committed to
 * `refs/turtle/ops/<member>/<replica>`, mirrored into the SQLite view.
 *
 * Write order inside the lock: commit objects → DB transaction (ops + view + tip) →
 * ref. A crash before the ref moves leaves the DB ahead; `repair()` moves the ref to the
 * DB's tip. A lost DB is rebuilt from the refs.
 */
export class OpLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: OpLogOptions) {}

  get ref(): string {
    return `${OPS_REF_PREFIX}${this.o.replica}`;
  }

  private tipKey(replica: string): string {
    return `tip:${replica}`;
  }

  /**
   * Append one batch. `validate` runs inside the lock against the current view and may
   * throw to reject the whole batch.
   */
  append(
    actor: Actor,
    changes: Change[],
    validate?: (changes: Change[]) => void,
  ): Promise<Operation[]> {
    if (!changes.length) return Promise.resolve([]);
    const run = this.chain.then(() =>
      withFileLock(this.o.lockFile, async () => {
        await this.repair();
        validate?.(changes);
        const { db } = this.o;
        const deps = db.versionVector();
        let seq = db.maxSeq(this.o.replica);
        const at = (this.o.now?.() ?? new Date()).toISOString();
        const ops: Operation[] = changes.map((change) => {
          seq += 1;
          const body: Omit<Operation, "id"> = {
            replica: this.o.replica,
            seq,
            deps: { ...deps, [this.o.replica]: seq - 1 },
            actor,
            at,
            change,
          };
          return { id: operationId(body), ...body };
        });
        const parent = db.getMeta(this.tipKey(this.o.replica));
        const commit = await this.writeBatch(ops, parent);
        db.transaction(() => {
          for (const op of ops) db.applyOp(op, commit);
          db.setMeta(this.tipKey(this.o.replica), commit);
        });
        await this.o.store.updateRef(this.ref, commit, parent);
        return ops;
      }),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async writeBatch(ops: Operation[], parent: string | null): Promise<string> {
    const { store } = this.o;
    const blob = await store.run(["hash-object", "-w", "--stdin"], {
      input: `${ops.map((op) => canonicalJson(op)).join("\n")}\n`,
    });
    const tree = await store.run(["mktree"], { input: `100644 blob ${blob}\t${OPS_FILE}\n` });
    const first = ops[0]?.seq ?? 0;
    const last = ops.at(-1)?.seq ?? 0;
    return store.commitTree(
      tree,
      parent ? [parent] : [],
      `turtle ops ${first}-${last}\n\nReplica: ${this.o.replica}\n`,
      this.o.committer,
    );
  }

  /** Bring this replica's ref and the DB back in line (see class comment). */
  async repair(): Promise<"ok" | "ref-moved" | "imported"> {
    const { db, store } = this.o;
    const refTip = await store.readRef(this.ref);
    const dbTip = db.getMeta(this.tipKey(this.o.replica));
    if (refTip === dbTip) return "ok";
    if (dbTip && (!refTip || (await isAncestor(store, refTip, dbTip)))) {
      await store.updateRef(this.ref, dbTip, refTip);
      return "ref-moved";
    }
    // The ref knows batches the DB does not (another clone, a restored DB): import.
    await importAll(store, db);
    return "imported";
  }
}

async function isAncestor(store: GitStore, ancestor: string, descendant: string): Promise<boolean> {
  const r = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    gitDir: store.commonDir,
    okCodes: [0, 1],
  });
  return r.exitCode === 0;
}

/** Read every batch on every replica ref: [commit, ops] oldest first per replica. */
export async function readAllBatches(
  store: GitStore,
): Promise<{ replica: string; commit: string; ops: Operation[] }[]> {
  const refs = await store.listRefs(OPS_REF_PREFIX);
  const out: { replica: string; commit: string; ops: Operation[] }[] = [];
  for (const { ref, sha } of refs) {
    const replica = ref.slice(OPS_REF_PREFIX.length);
    const chain: { replica: string; commit: string; ops: Operation[] }[] = [];
    let cur: string | undefined = sha;
    while (cur) {
      const info = await store.readCommit(cur);
      const text = await store.run(["cat-file", "blob", `${info.tree}:${OPS_FILE}`]);
      const ops = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Operation);
      chain.push({ replica, commit: cur, ops });
      cur = info.parents[0];
    }
    out.push(...chain.reverse());
  }
  return out;
}

/**
 * Causal order: an operation comes after everything its version vector names; ties by
 * (at, replica, seq). With one replica this is simply seq order.
 */
export function causalOrder(ops: Operation[]): Operation[] {
  const pending = [...ops].sort(
    (a, b) => a.at.localeCompare(b.at) || a.replica.localeCompare(b.replica) || a.seq - b.seq,
  );
  const applied = new Map<string, number>();
  const out: Operation[] = [];
  while (pending.length) {
    const i = pending.findIndex((op) =>
      Object.entries({ ...op.deps, [op.replica]: op.seq - 1 }).every(
        ([r, s]) => (applied.get(r) ?? 0) >= s,
      ),
    );
    // A missing dependency (a replica not fetched) must not block the rest forever.
    const next = pending.splice(i === -1 ? 0 : i, 1)[0] as Operation;
    out.push(next);
    applied.set(next.replica, Math.max(applied.get(next.replica) ?? 0, next.seq));
  }
  return out;
}

/** Rebuild the view from the refs (`turtle doctor --rebuild`, or a ref ahead of the DB). */
export async function importAll(store: GitStore, db: GraphDb): Promise<number> {
  const batches = await readAllBatches(store);
  const batchOf = new Map<string, string>();
  for (const b of batches) for (const op of b.ops) batchOf.set(op.id, b.commit);
  const ordered = causalOrder(batches.flatMap((b) => b.ops));
  let n = 0;
  db.transaction(() => {
    for (const op of ordered) {
      if (db.hasOp(op.id)) continue;
      db.applyOp(op, batchOf.get(op.id) as string);
      n++;
    }
    const tips = new Map<string, string>();
    for (const b of batches) tips.set(b.replica, b.commit);
    for (const [replica, commit] of tips) db.setMeta(`tip:${replica}`, commit);
  });
  return n;
}

export async function rebuild(store: GitStore, db: GraphDb): Promise<number> {
  db.clear();
  return importAll(store, db);
}
