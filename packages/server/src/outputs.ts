import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { GitStore, type Project, TurtleDb } from "@turtle/core";
import type { OutputContentResponse } from "./api.js";
import { RouteError } from "./graph-routes.js";

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
  primary: { id: string | null; store: GitStore; db: TurtleDb },
  conceptId: string,
): Promise<OutputContentResponse> {
  const out = project.getConcept(conceptId);
  if (out?.kind !== "output" || !out.path) throw new RouteError(404, "not an output");
  const task = out.parentId ? project.getConcept(out.parentId) : null;
  if (!task?.branches?.length) throw new RouteError(404, "the output's task has no branch");

  // In a multi-source workspace the path starts with the source's directory.
  let rel = normalize(out.path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new RouteError(400, "bad output path");
  let sourceId = primary.id;
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
    (sourceId === primary.id ? task.branches[0] : undefined);
  if (!ref) throw new RouteError(404, "the output's source has no branch for this task");

  let store = primary.store;
  let db = primary.db;
  let close = () => {};
  if (sourceId && sourceId !== primary.id) {
    const src = sources.find((s) => s.id === sourceId);
    if (!src) throw new RouteError(404, `unknown source ${sourceId}`);
    store = await GitStore.open(src.path);
    db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    close = () => db.close();
  }
  try {
    const branch = db.getBranch(ref.branch);
    if (!branch) throw new RouteError(404, "the task's branch is not in this source");
    const found = (data: Buffer, at: string): OutputContentResponse => {
      const binary = data.subarray(0, 8000).includes(0);
      const r: OutputContentResponse = {
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

    let latest: OutputContentResponse | null = null;
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
    throw new RouteError(404, `${out.path} is not in the task's workspace or checkpoints`);
  } finally {
    close();
  }
}
