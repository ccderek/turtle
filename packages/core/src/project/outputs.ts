import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { TurtleDb } from "../db/db.js";
import { GitStore } from "../git/store.js";
import { NotFoundError, OpsError } from "../ops.js";
import type { Project } from "./project.js";

/** An output file's content, from the task's workspace or checkpoints. */
export interface OutputContent {
  path: string;
  size: number;
  sha256: string;
  /** False when only another version than the one the agent cited was found. */
  matches: boolean;
  /** "workspace" or the checkpoint node it was read from. */
  at: string;
  binary: boolean;
  truncated: boolean;
  text?: string;
}

const MAX_TEXT = 256 * 1024;
const MAX_WALK = 500;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * The content of an output concept (phase2-spec §12, the Outputs tab). The file is looked
 * up where the agent wrote it: first the task's workspace, then the checkpoints of the
 * task's branch from newest to oldest, preferring the version whose sha256 matches the
 * one recorded when the agent cited it.
 */
export async function readOutput(
  project: Project,
  conceptId: string,
  /** The primary source, already open (the server's); others are opened as needed. */
  primary?: { id: string | null; store: GitStore; db: TurtleDb },
): Promise<OutputContent> {
  const out = project.getConcept(conceptId);
  if (out?.kind !== "output" || !out.path) throw new NotFoundError("not an output");
  const task = out.parentId ? project.getConcept(out.parentId) : null;
  if (!task?.branches?.length) throw new NotFoundError("the output's task has no branch");

  // In a multi-source workspace the path starts with the source's directory.
  let rel = normalize(out.path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new OpsError("bad output path");
  // The task's first branch is on its primary source.
  const primaryId = primary?.id ?? task.branches[0]?.source ?? null;
  let sourceId = primaryId;
  const sources = project.config.sources;
  if (sources.length > 1) {
    const [first, ...rest] = rel.split(sep);
    if (first && rest.length && sources.some((s) => s.id === first)) {
      sourceId = first;
      rel = rest.join("/");
    }
  }
  const ref =
    task.branches.find((b) => b.source === sourceId) ??
    (sourceId === primaryId ? task.branches[0] : undefined);
  if (!ref) throw new NotFoundError("the output's source has no branch for this task");

  let store: GitStore;
  let db: TurtleDb;
  let close = () => {};
  if (primary && sourceId === primary.id) {
    store = primary.store;
    db = primary.db;
  } else {
    const src = sources.find((s) => s.id === ref.source);
    if (!src) throw new NotFoundError(`unknown source ${ref.source}`);
    store = await GitStore.open(src.path);
    const opened = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    db = opened;
    close = () => opened.close();
  }
  try {
    const branch = db.getBranch(ref.branch);
    if (!branch) throw new NotFoundError("the task's branch is not in this source");
    const found = (data: Buffer, at: string): OutputContent => {
      const binary = data.subarray(0, 8000).includes(0);
      const r: OutputContent = {
        path: out.path as string,
        size: data.length,
        sha256: sha256(data),
        matches: !out.sha256 || sha256(data) === out.sha256,
        at,
        binary,
        truncated: !binary && data.length > MAX_TEXT,
      };
      if (!binary) r.text = data.subarray(0, MAX_TEXT).toString("utf8");
      return r;
    };

    let latest: OutputContent | null = null;
    if (branch.workspacePath) {
      try {
        const r = found(await readFile(join(branch.workspacePath, rel)), "workspace");
        if (r.matches) return r;
        latest = r;
      } catch {}
    }
    let node = branch.headNodeId ? db.getNode(branch.headNodeId) : null;
    for (let i = 0; node && i < MAX_WALK; i++) {
      try {
        const r = found(await store.readBlob(`${node.commitSha}:${rel}`), node.id);
        if (r.matches) return r;
        latest ??= r;
      } catch {}
      node = node.parents[0] ? db.getNode(node.parents[0]) : null;
    }
    if (latest) return latest;
    throw new NotFoundError(`${out.path} is not in the task's workspace or checkpoints`);
  } finally {
    close();
  }
}
