import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { TurtleDb } from "../src/db/db.js";
import { git } from "../src/git/exec.js";
import { GitStore } from "../src/git/store.js";
import { resolveCheckpointParts } from "../src/run/companion.js";
import { type RunOptions, RunSession } from "../src/run/session.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

async function setup() {
  const scripts = await makeRepo({ "run.sh": "echo v0\n" });
  const models = await makeRepo({ "m.txt": "v0\n" });
  const sStore = await GitStore.open(scripts);
  const mStore = await GitStore.open(models);
  const sDb = TurtleDb.open(join(sStore.turtleDir, "turtle.db"));
  const mDb = TurtleDb.open(join(mStore.turtleDir, "turtle.db"));
  const workspaceRoot = await tempDir("turtle-ws-");
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const run = async (prompt: string, script: FakeScript, extra: Partial<RunOptions> = {}) => {
    const s = await RunSession.start(
      {
        store: sStore,
        db: sDb,
        config,
        summarizer: new HeuristicSummarizer(),
        launcher: fakeLauncher(script),
        workspaceRoot,
      },
      {
        prompt,
        companions: [{ id: "models", store: mStore, db: mDb }],
        primarySourceId: "scripts",
        ...extra,
      },
    );
    return { s, out: await s.done };
  };
  return { scripts, models, sStore, mStore, sDb, mDb, workspaceRoot, run };
}

describe("multi-source runs", () => {
  it("snapshots every source into one checkpoint and lays out one directory per source", async () => {
    const t = await setup();
    let cwd = "";
    let diffText = "";
    const { s, out } = await t.run("Measure model A", async (a) => {
      cwd = a.workspace;
      await a.edit("scripts/run.sh", "echo v1\n");
      await a.edit("models/m.txt", "v1\n");
      diffText = (await a.diff()).diff;
      await a.checkpoint("Both sources changed", "done");
      await a.finish();
    });
    expect(out.reason).toBe("done");
    expect(cwd).toBe(join(t.workspaceRoot, s.branchId));
    expect(existsSync(join(cwd, "scripts", "run.sh"))).toBe(true);
    expect(await readFile(join(cwd, "models", "m.txt"), "utf8")).toBe("v1\n");
    expect(diffText).toContain("+++ b/scripts/run.sh");
    expect(diffText).toContain("+++ b/models/m.txt");

    const semantic = t.sDb.listNodes({ branchId: s.branchId, kinds: ["semantic"] });
    expect(semantic).toHaveLength(1);
    const cp = semantic[0];
    expect(cp).toMatchObject({ filesChanged: 2, linesAdded: 2, linesDeleted: 2 });

    // The companion has its own branch with nodes pointing back at the checkpoint.
    const [mBranch] = t.mDb.listBranches();
    expect(mBranch?.status).toBe("done");
    const mNodes = t.mDb.listNodes({ branchId: mBranch?.id as string });
    expect(mNodes.map((n) => n.kind)).toEqual(["root", "micro", "semantic"]);
    expect(mNodes.at(-1)?.tags).toEqual([`checkpoint:${cp?.id}`]);
    const msg = await git(["log", "-1", "--format=%B", mNodes.at(-1)?.commitSha as string], {
      cwd: t.models,
    });
    expect(msg).toContain(`Turtle-Checkpoint: ${cp?.id}`);
    expect(await git(["show", `${mNodes.at(-1)?.commitSha}:m.txt`], { cwd: t.models })).toBe("v1");
    expect(t.mDb.listAgents()[0]).toMatchObject({ adapter: "companion", status: "done" });

    // The checkpoint resolves to one part per companion.
    const parts = resolveCheckpointParts(t.sDb, cp?.id as string);
    expect(parts.get("models")?.nodeId).toBe(mNodes.at(-1)?.id);
  });

  it("makes a checkpoint when only a companion changed", async () => {
    const t = await setup();
    const { s } = await t.run("Only models", async (a) => {
      await a.edit("models/m.txt", "only-models\n");
      await a.finish();
    });
    const micros = t.sDb.listNodes({ branchId: s.branchId, kinds: ["micro"] });
    expect(micros.length).toBeGreaterThan(0);
    const parts = resolveCheckpointParts(t.sDb, micros[0]?.id as string);
    const part = parts.get("models");
    expect(await git(["show", `${part?.commit}:m.txt`], { cwd: t.models })).toBe("only-models");
  });

  it("continues the same companion branches and forks every source from a checkpoint", async () => {
    const t = await setup();
    const first = await t.run("Step 1", async (a) => {
      await a.edit("models/m.txt", "v1\n");
      await a.checkpoint("Model v1");
      await a.edit("models/m.txt", "v2\n");
      await a.checkpoint("Model v2", "need_decision");
      await a.finish("Keep v2?");
    });
    const [v1, v2] = t.sDb.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] });
    const mBranchId = t.mDb.listBranches()[0]?.id;

    // Continue: same primary and companion branches, same workspace.
    let seen = "";
    const cont = await t.run(
      "Yes",
      async (a) => {
        seen = await readFile(join(a.workspace, "models", "m.txt"), "utf8");
        await a.edit("scripts/run.sh", "echo keep\n");
        await a.finish();
      },
      { from: v2?.id as string },
    );
    expect(cont.s.mode).toBe("continue");
    expect(seen).toBe("v2\n");
    expect(t.mDb.listBranches().map((b) => b.id)).toEqual([mBranchId]);

    // Fork from v1: the companion is restored to its state at that checkpoint.
    let forked = "";
    const fork = await t.run(
      "Try v1 differently",
      async (a) => {
        forked = await readFile(join(a.workspace, "models", "m.txt"), "utf8");
        await a.finish();
      },
      { from: v1?.id as string },
    );
    expect(fork.s.mode).toBe("fork");
    expect(forked).toBe("v1\n");
    const mBranches = t.mDb.listBranches();
    expect(mBranches).toHaveLength(2);
    expect(mBranches[1]?.forkedFromNodeId).toBeTruthy();
  });
});
