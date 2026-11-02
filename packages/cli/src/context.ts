import { join } from "node:path";
import {
  type Branch,
  GitStore,
  loadConfig,
  reconcile,
  shortestUniquePrefixes,
  type TurtleConfig,
  TurtleDb,
  type TurtleNode,
} from "@turtle/core";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface Context {
  cwd: string;
  store: GitStore;
  db: TurtleDb;
  config: TurtleConfig;
}

export async function openContext(
  cwd: string,
  opts: { reconcile?: boolean } = {},
): Promise<Context> {
  let store: GitStore;
  try {
    store = await GitStore.open(cwd);
  } catch {
    throw new CliError(`not a git repository: ${cwd}`);
  }
  const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
  const config = await loadConfig(store.topLevel ?? cwd);
  if (opts.reconcile !== false) await reconcile(store, db);
  return { cwd, store, db, config };
}

/**
 * Resolve what a human typed into a node: a node id prefix, a snapshot name,
 * or a branch id prefix (meaning that branch's head).
 */
export function resolveNode(db: TurtleDb, ref: string): TurtleNode {
  const snap = db.getSnapshot(ref);
  if (snap) {
    const n = db.getNode(snap.nodeId);
    if (n) return n;
  }
  const nodes = db.findNodesByPrefix(ref, 5);
  if (nodes.length === 1 && nodes[0]) return nodes[0];
  if (nodes.length > 1) {
    throw new CliError(`ambiguous node id "${ref}": ${nodes.map((n) => n.id).join(", ")}`);
  }
  const branch = resolveBranch(db, ref, false);
  if (branch?.headNodeId) {
    const n = db.getNode(branch.headNodeId);
    if (n) return n;
  }
  throw new CliError(`unknown node, snapshot or branch: ${ref}`);
}

export function resolveBranch(db: TurtleDb, ref: string, required = true): Branch | null {
  const matches = db.listBranches().filter((b) => b.id.startsWith(ref) || b.name === ref);
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1)
    throw new CliError(`ambiguous branch "${ref}": ${matches.map((b) => b.id).join(", ")}`);
  if (required) throw new CliError(`unknown branch: ${ref}`);
  return null;
}

/** Shortest unique display prefixes for all node and branch ids. */
export function shortIds(db: TurtleDb): (id: string) => string {
  const nodes = shortestUniquePrefixes(db.listNodes().map((n) => n.id));
  const branches = shortestUniquePrefixes(db.listBranches().map((b) => b.id));
  return (id) => nodes.get(id) ?? branches.get(id) ?? id.slice(0, 6);
}
