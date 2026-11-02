import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TurtleDb } from "../src/db/db.js";
import { type TurtleNode, ZERO_TOKENS } from "../src/db/types.js";
import { newId } from "../src/ids.js";
import { tempDir } from "./helpers.js";

function node(
  overrides: Partial<TurtleNode> & Pick<TurtleNode, "id" | "branchId">,
): Omit<TurtleNode, "createdAt"> {
  return {
    agentId: null,
    kind: "semantic",
    parents: [],
    commitSha: `c-${overrides.id}`,
    treeSha: `t-${overrides.id}`,
    intent: null,
    summary: null,
    summarySource: null,
    status: "progress",
    trigger: null,
    sessionId: null,
    resumeToolUseId: null,
    resumeMessageUuid: null,
    tests: null,
    filesChanged: null,
    linesAdded: null,
    linesDeleted: null,
    tokens: { ...ZERO_TOKENS },
    costUsdEst: 0,
    tags: [],
    explorationGroupId: null,
    ...overrides,
  };
}

function seed(db: TurtleDb) {
  const branch = db.insertBranch({
    id: "b1",
    name: null,
    ref: "refs/turtle/branches/b1",
    rootNodeId: "root1",
    forkedFromNodeId: null,
    headNodeId: null,
    workspacePath: "/ws/b1",
    status: "running",
  });
  const agent = db.insertAgent({
    id: "a1",
    branchId: "b1",
    adapter: "claude-agent-sdk",
    adapterLevel: 2,
    model: "claude-opus-5-5",
    sandbox: "none",
    sessionId: null,
    prompt: "do it",
    status: "running",
    pid: 123,
  });
  return { branch, agent };
}

describe("TurtleDb", () => {
  it("migrates a new file database and reopens it", async () => {
    const path = join(await tempDir(), "turtle", "turtle.db");
    const db = TurtleDb.open(path);
    expect(db.schemaVersion).toBe(1);
    db.setMeta("repo_id", "r1");
    db.close();
    const again = TurtleDb.open(path);
    expect(again.schemaVersion).toBe(1);
    expect(again.getMeta("repo_id")).toBe("r1");
    expect(again.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    again.close();
  });

  it("stores branches and agents and applies partial updates", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    db.updateBranch("b1", { headNodeId: "n1", status: "idle" });
    db.updateAgent("a1", { sessionId: "s1", status: "done", totalCostUsd: 0.42, numTurns: 7 });
    expect(db.getBranch("b1")).toMatchObject({
      headNodeId: "n1",
      status: "idle",
      workspacePath: "/ws/b1",
    });
    expect(db.getAgent("a1")).toMatchObject({
      sessionId: "s1",
      status: "done",
      totalCostUsd: 0.42,
      numTurns: 7,
    });
    expect(db.listAgents({ status: "done" }).map((a) => a.id)).toEqual(["a1"]);
    expect(db.listAgents({ status: "running" })).toEqual([]);
    expect(db.listAgents().length).toBe(1);
    expect(db.listBranches().map((b) => b.id)).toEqual(["b1"]);
  });

  it("stores nodes with parents, tokens and tags, and walks the tree", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    db.insertNode(node({ id: "root1", branchId: "b1", kind: "root" }));
    db.insertNode(
      node({
        id: "n1",
        branchId: "b1",
        agentId: "a1",
        parents: ["root1"],
        summary: "Add flag",
        summarySource: "agent_declared",
        tokens: { input: 10, cacheRead: 200, cacheWrite: 5, output: 30 },
        tags: ["experiment"],
        filesChanged: 2,
        linesAdded: 40,
        linesDeleted: 3,
      }),
    );
    db.insertNode(node({ id: "n2", branchId: "b1", kind: "micro", parents: ["n1"] }));
    db.insertNode(node({ id: "n3", branchId: "b1", parents: ["n1"] }));

    const n1 = db.getNode("n1");
    expect(n1).toMatchObject({
      parents: ["root1"],
      summary: "Add flag",
      tokens: { input: 10, cacheRead: 200, cacheWrite: 5, output: 30 },
      tags: ["experiment"],
      linesAdded: 40,
    });
    expect(db.getNodeByCommit("c-n1")?.id).toBe("n1");
    expect(db.childrenOf("n1").map((n) => n.id)).toEqual(["n2", "n3"]);
    expect(db.listNodes({ branchId: "b1", kinds: ["semantic"] }).map((n) => n.id)).toEqual([
      "n1",
      "n3",
    ]);

    db.updateNode("n1", { status: "need_decision", tags: ["experiment", "keep"] });
    expect(db.getNode("n1")).toMatchObject({
      status: "need_decision",
      tags: ["experiment", "keep"],
    });
  });

  it("rejects a node whose parent does not exist", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    expect(() => db.insertNode(node({ id: "x", branchId: "b1", parents: ["missing"] }))).toThrow();
    expect(db.getNode("x")).toBeNull();
  });

  it("resolves short id prefixes", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    const ids = ["k2pzq7wd0000", "k2pzzzzz0000", "x9df00000000"];
    for (const id of ids) db.insertNode(node({ id, branchId: "b1" }));
    expect(db.findNodesByPrefix("k2pz").map((n) => n.id)).toEqual(["k2pzq7wd0000", "k2pzzzzz0000"]);
    expect(db.findNodesByPrefix("k2pzq").map((n) => n.id)).toEqual(["k2pzq7wd0000"]);
    expect(db.findNodesByPrefix("zzzz")).toEqual([]);
  });

  it("fills resume points when the tool result arrives", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    db.insertNode(node({ id: "n1", branchId: "b1", agentId: "a1", resumeToolUseId: "toolu_1" }));
    db.insertNode(node({ id: "n2", branchId: "b1", agentId: "a1", resumeToolUseId: "toolu_2" }));
    expect(db.resolveResumePoint("a1", "toolu_1", "uuid-1")).toEqual(["n1"]);
    expect(db.resolveResumePoint("a1", "toolu_1", "uuid-again")).toEqual([]);
    expect(db.getNode("n1")?.resumeMessageUuid).toBe("uuid-1");
    expect(db.getNode("n2")?.resumeMessageUuid).toBeNull();
  });

  it("appends messages per agent and attributes them to nodes", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    db.insertNode(node({ id: "n1", branchId: "b1" }));
    expect(db.appendMessage("a1", { type: "system", json: "{}" })).toBe(1);
    expect(
      db.appendMessage("a1", { type: "assistant", uuid: "u2", sessionId: "s", json: "{}" }),
    ).toBe(2);
    expect(db.attachPendingMessages("a1", "n1")).toBe(2);
    db.appendMessage("a1", { type: "user", uuid: "u3", parentToolUseId: "toolu_x", json: "{}" });
    expect(db.listMessages("a1", { nodeId: "n1" }).map((m) => m.seq)).toEqual([1, 2]);
    expect(db.listMessages("a1", { afterSeq: 2 })).toMatchObject([
      { seq: 3, uuid: "u3", nodeId: null },
    ]);
  });

  it("logs events, artifacts and snapshots", () => {
    const db = TurtleDb.open(":memory:");
    seed(db);
    db.insertNode(node({ id: "n1", branchId: "b1" }));
    const e1 = db.appendEvent({
      actorType: "agent",
      actorId: "a1",
      type: "tool_call",
      branchId: "b1",
      nodeId: null,
      agentId: "a1",
      payload: { tool: "Edit" },
    });
    db.appendEvent({
      actorType: "human",
      actorId: null,
      type: "tag",
      branchId: null,
      nodeId: "n1",
      agentId: null,
      payload: {},
    });
    expect(e1.seq).toBe(1);
    expect(db.listEvents({ agentId: "a1" })).toMatchObject([
      { type: "tool_call", payload: { tool: "Edit" } },
    ]);
    expect(db.listEvents({ afterSeq: 1 }).map((e) => e.type)).toEqual(["tag"]);

    const art = db.insertArtifact({
      nodeId: "n1",
      label: "shot",
      path: "out.png",
      blobSha: "abc",
      mime: "image/png",
      size: 7,
    });
    expect(db.listArtifacts("n1")).toEqual([art]);

    db.putSnapshot("good", "n1");
    expect(db.getSnapshot("good")?.nodeId).toBe("n1");
    expect(db.listSnapshots().map((s) => s.name)).toEqual(["good"]);
    db.deleteSnapshot("good");
    expect(db.getSnapshot("good")).toBeNull();
  });

  it("generates unique event ids", () => {
    const db = TurtleDb.open(":memory:");
    const ids = new Set(
      Array.from(
        { length: 50 },
        () =>
          db.appendEvent({
            actorType: "system",
            actorId: null,
            type: "x",
            branchId: null,
            nodeId: null,
            agentId: null,
            payload: {},
          }).id,
      ),
    );
    expect(ids.size).toBe(50);
    expect(newId()).toHaveLength(12);
  });
});
