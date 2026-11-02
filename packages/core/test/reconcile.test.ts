import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurtleDb } from "../src/db/db.js";
import { reconcile } from "../src/db/reconcile.js";
import { ZERO_TOKENS } from "../src/db/types.js";
import { AGENT_IDENTITY, BRANCH_REF_PREFIX, GitStore } from "../src/git/store.js";
import { makeRepo, tempDir, writeFiles } from "./helpers.js";

async function setup() {
  const repo = await makeRepo({ "a.txt": "a\n" });
  const store = await GitStore.open(repo);
  const db = TurtleDb.open(":memory:");
  const ref = `${BRANCH_REF_PREFIX}b1`;
  const root = await store.snapshotWorkingCopy({
    indexFile: join(store.turtleDir, "index", "root"),
    message: {
      title: "root",
      trailers: { "Turtle-Node": "root00000000", "Turtle-Kind": "root", "Turtle-Branch": "b1" },
    },
    identity: await store.userIdentity(),
  });
  await store.updateRef(ref, root.commit, null);
  const ws = join(await tempDir(), "ws");
  const indexFile = store.indexFileFor("b1");
  await store.materialize(root.commit, ws, indexFile);
  return { store, db, ref, root, ws, indexFile };
}

describe("reconcile", () => {
  it("imports a whole branch from commit trailers when the DB is empty", async () => {
    const { store, db, ref, root, ws, indexFile } = await setup();
    await writeFiles(ws, { "b.txt": "b\nb\n" });
    const n1 = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: {
        title: "Add b",
        body: "Because.",
        trailers: {
          "Turtle-Node": "node10000000",
          "Turtle-Kind": "semantic",
          "Turtle-Status": "done",
          "Turtle-Branch": "b1",
          "Turtle-Agent": "ghostagent00",
          "Turtle-Summary-Source": "agent_declared",
        },
      },
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
      ref: { name: ref, expectedOld: root.commit },
    });

    const report = await reconcile(store, db);
    expect(report.createdBranches).toEqual(["b1"]);
    expect(report.importedNodes).toEqual(["root00000000", "node10000000"]);
    expect(db.getBranch("b1")).toMatchObject({
      rootNodeId: "root00000000",
      headNodeId: "node10000000",
      status: "idle",
    });
    expect(db.getNode("root00000000")).toMatchObject({ kind: "root", parents: [] });
    expect(db.getNode("node10000000")).toMatchObject({
      kind: "semantic",
      status: "done",
      parents: ["root00000000"],
      commitSha: n1?.commit,
      summary: "Add b\n\nBecause.",
      summarySource: "agent_declared",
      agentId: null, // unknown agent is not invented
      filesChanged: 1,
      linesAdded: 2,
      tags: ["reconciled"],
    });

    // Idempotent.
    expect((await reconcile(store, db)).importedNodes).toEqual([]);
  });

  it("imports only the commits missing after a crash", async () => {
    const { store, db, ref, root, ws, indexFile } = await setup();
    db.insertBranch({
      id: "b1",
      name: null,
      ref,
      rootNodeId: "root00000000",
      forkedFromNodeId: null,
      headNodeId: "root00000000",
      workspacePath: ws,
      status: "running",
    });
    db.insertNode({
      id: "root00000000",
      branchId: "b1",
      agentId: null,
      kind: "root",
      parents: [],
      commitSha: root.commit,
      treeSha: root.tree,
      intent: null,
      summary: "root",
      summarySource: null,
      status: "done",
      trigger: null,
      sessionId: null,
      resumeToolUseId: null,
      resumeMessageUuid: null,
      tests: null,
      filesChanged: 0,
      linesAdded: 0,
      linesDeleted: 0,
      tokens: { ...ZERO_TOKENS },
      costUsdEst: 0,
      tags: [],
      explorationGroupId: null,
    });
    // Commit + ref written, then "crash" before the DB insert.
    await writeFiles(ws, { "c.txt": "c\n" });
    await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: {
        title: "micro: after Write",
        trailers: { "Turtle-Node": "micro0000000", "Turtle-Kind": "micro", "Turtle-Branch": "b1" },
      },
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
      ref: { name: ref, expectedOld: root.commit },
    });

    const report = await reconcile(store, db);
    expect(report.importedNodes).toEqual(["micro0000000"]);
    expect(report.createdBranches).toEqual([]);
    expect(db.getNode("micro0000000")?.parents).toEqual(["root00000000"]);
    expect(db.getBranch("b1")?.headNodeId).toBe("micro0000000");
  });

  it("marks agents whose process is gone as failed", async () => {
    const { store, db } = await setup();
    await reconcile(store, db); // import root + branch
    db.updateBranch("b1", { status: "running" });
    db.insertAgent({
      id: "a1",
      branchId: "b1",
      adapter: "claude-agent-sdk",
      adapterLevel: 2,
      model: null,
      sandbox: "none",
      sessionId: null,
      prompt: "p",
      status: "running",
      pid: 999_999,
    });
    const report = await reconcile(store, db, { isProcessAlive: () => false });
    expect(report.failedAgents).toEqual(["a1"]);
    expect(db.getAgent("a1")?.status).toBe("failed");
    expect(db.getBranch("b1")?.status).toBe("failed");
    expect(db.listEvents({ type: "reconcile" }).at(-1)?.payload).toMatchObject({
      failedAgents: ["a1"],
    });
  });
});
