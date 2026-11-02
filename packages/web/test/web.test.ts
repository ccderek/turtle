import { describe, expect, it } from "vitest";
import type { BranchView, NodeView } from "../src/api.js";
import { parseDiff } from "../src/diff.js";
import { ago, money, shortIds } from "../src/format.js";
import { layoutTree, topoByTime } from "../src/layout.js";

let clock = 0;
function node(
  id: string,
  branchId: string,
  parent: string | null,
  extra: Partial<NodeView> = {},
): NodeView {
  clock += 1000;
  return {
    id,
    branchId,
    agentId: null,
    kind: parent ? "semantic" : "root",
    parents: parent ? [parent] : [],
    commitSha: id,
    treeSha: id,
    intent: null,
    summary: id,
    summarySource: "agent_declared",
    status: "progress",
    trigger: null,
    sessionId: null,
    resumeToolUseId: null,
    resumeMessageUuid: null,
    tests: null,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsdEst: 0,
    tags: [],
    explorationGroupId: null,
    createdAt: new Date(clock).toISOString(),
    displayParent: parent,
    hiddenSteps: 0,
    ...extra,
  };
}

function branch(id: string, status: BranchView["status"]): BranchView {
  return {
    id,
    name: null,
    ref: `refs/turtle/branches/${id}`,
    rootNodeId: "",
    forkedFromNodeId: null,
    headNodeId: null,
    workspacePath: null,
    status,
    createdAt: "",
    updatedAt: "",
    checkpointHeadId: null,
    pendingSteps: 0,
    costUsd: 0,
    lastError: null,
  };
}

describe("tree layout", () => {
  it("puts newest first, one lane per branch, with fork edges", () => {
    const r = node("r", "A", null);
    const a1 = node("a1", "A", "r");
    const b1 = node("b1", "B", "a1");
    const a2 = node("a2", "A", "a1");
    const b2 = node("b2", "B", "b1");
    const l = layoutTree([r, a1, b1, a2, b2], [branch("A", "done"), branch("B", "running")]);
    expect(l.rows.map((x) => x.node.id)).toEqual(["b2", "a2", "b1", "a1", "r"]);
    expect(l.rows.map((x) => x.index)).toEqual([0, 1, 2, 3, 4]);
    const lane = (id: string) => l.rows.find((x) => x.node.id === id)?.lane;
    expect(lane("r")).toBe(lane("a2"));
    expect(lane("b1")).not.toBe(lane("a1"));
    expect(l.lanes).toBe(2);
    const fork = l.edges.find((e) => e.fork);
    expect(fork).toMatchObject({ from: { row: 2 }, to: { row: 3 } });
    expect(l.edges.filter((e) => !e.fork)).toHaveLength(3);
  });

  it("reuses the lane of a finished branch", () => {
    const r1 = node("r1", "A", null);
    const a = node("a", "A", "r1");
    const r2 = node("r2", "B", null);
    const b = node("b", "B", "r2");
    const l = layoutTree([r1, a, r2, b], [branch("A", "done"), branch("B", "done")]);
    expect(new Set(l.rows.map((x) => x.lane))).toEqual(new Set([0]));
    expect(l.lanes).toBe(1);
  });

  it("orders parents before children even when timestamps tie", () => {
    const p = node("zzz", "A", null, { createdAt: "2026-01-01T00:00:00.000Z" });
    const c = node("aaa", "A", "zzz", { createdAt: "2026-01-01T00:00:00.000Z" });
    expect(topoByTime([c, p]).map((n) => n.id)).toEqual(["zzz", "aaa"]);
  });
});

describe("diff parsing", () => {
  it("splits files and counts lines", () => {
    const files = parseDiff(
      [
        "diff --git a/a.txt b/a.txt",
        "index 1..2 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " same",
        "-old",
        "+new",
        "diff --git a/b.txt b/b.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.txt",
        "@@ -0,0 +1 @@",
        "+b",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.added, f.deleted])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["b.txt", "added", 1, 0],
    ]);
  });
});

describe("format", () => {
  it("shortens ids to unique prefixes of at least 4", () => {
    const s = shortIds(["abcdef", "abcxyz", "zzzzzz"]);
    expect([s("abcdef"), s("abcxyz"), s("zzzzzz")]).toEqual(["abcd", "abcx", "zzzz"]);
  });
  it("formats money and time", () => {
    expect([money(0), money(0.004), money(1.234), money(null)]).toEqual([
      "$0",
      "<$0.01",
      "$1.23",
      "—",
    ]);
    expect(ago(new Date(0).toISOString(), 90_000)).toBe("2m ago");
  });
});
