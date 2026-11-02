import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import {
  AGENT_IDENTITY,
  BRANCH_REF_PREFIX,
  GitStore,
  RefConflictError,
  SNAPSHOT_REF_PREFIX,
} from "../src/git/store.js";
import { makeRepo, tempDir, writeFiles } from "./helpers.js";

async function lsTree(store: GitStore, tree: string): Promise<string[]> {
  const out = await store.run(["ls-tree", "-r", "--name-only", tree]);
  return out ? out.split("\n") : [];
}

/** Repo + store + a workspace materialized from a root snapshot of HEAD. */
async function setup(files?: Record<string, string>) {
  const repo = await makeRepo(files);
  const store = await GitStore.open(repo);
  const root = await store.snapshotWorkingCopy({
    indexFile: join(store.turtleDir, "index", "tmp-root"),
    message: "root",
    identity: await store.userIdentity(),
  });
  const ws = join(await tempDir("turtle-ws-"), "ws");
  const indexFile = store.indexFileFor("b1");
  await store.materialize(root.commit, ws, indexFile);
  return { repo, store, root, ws, indexFile };
}

describe("GitStore.open", () => {
  it("finds the git dirs and places turtle state under the common dir", async () => {
    const repo = await makeRepo();
    const store = await GitStore.open(join(repo));
    expect(store.commonDir).toBe(join(repo, ".git"));
    expect(store.gitDir).toBe(join(repo, ".git"));
    expect(store.topLevel).toBe(repo);
    expect(store.turtleDir).toBe(join(repo, ".git", "turtle"));
  });

  it("uses the main repo's common dir from a linked worktree", async () => {
    const repo = await makeRepo();
    const linked = join(await tempDir(), "linked");
    await git(["worktree", "add", "-q", "-b", "other", linked], { cwd: repo });
    const store = await GitStore.open(linked);
    expect(store.commonDir).toBe(join(repo, ".git"));
    expect(store.gitDir).not.toBe(store.commonDir);
    expect(store.topLevel).toBe(linked);
  });

  it("rejects a directory that is not a repository", async () => {
    await expect(GitStore.open(await tempDir())).rejects.toThrow();
  });
});

describe("snapshotWorkingCopy (root node)", () => {
  it("includes uncommitted and untracked changes and honors .gitignore", async () => {
    const repo = await makeRepo({ "a.txt": "a\n", ".gitignore": "secret.env\n" });
    await writeFiles(repo, { "a.txt": "a changed\n", "new.txt": "new\n", "secret.env": "x" });
    const store = await GitStore.open(repo);
    const head = await store.resolveHead();
    const root = await store.snapshotWorkingCopy({
      indexFile: join(store.turtleDir, "index", "root"),
      message: "root",
      identity: await store.userIdentity(),
    });
    expect(root.head).toBe(head);
    expect(root.dirty).toBe(true);
    expect(await lsTree(store, root.tree)).toEqual([".gitignore", "a.txt", "new.txt"]);
    const info = await store.readCommit(root.commit);
    expect(info.parents).toEqual([head]);
    // The user's own index and status are untouched.
    expect(await git(["status", "--porcelain"], { cwd: repo })).toContain("?? new.txt");
    expect(existsSync(join(store.turtleDir, "index", "root"))).toBe(false);
  });

  it("uses HEAD's tree with fromHead", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    await writeFiles(repo, { "a.txt": "dirty\n" });
    const store = await GitStore.open(repo);
    const root = await store.snapshotWorkingCopy({
      indexFile: join(store.turtleDir, "index", "root"),
      message: "root",
      identity: await store.userIdentity(),
      fromHead: true,
    });
    expect(root.dirty).toBe(false);
    expect(root.tree).toBe(await store.run(["rev-parse", "HEAD^{tree}"]));
  });

  it("works on an unborn branch (no parent)", async () => {
    const repo = await makeRepo({});
    await writeFiles(repo, { "first.txt": "1\n" });
    const store = await GitStore.open(repo);
    const root = await store.snapshotWorkingCopy({
      indexFile: join(store.turtleDir, "index", "root"),
      message: "root",
      identity: await store.userIdentity(),
    });
    expect(root.head).toBeNull();
    expect((await store.readCommit(root.commit)).parents).toEqual([]);
    expect(await lsTree(store, root.tree)).toEqual(["first.txt"]);
  });

  it("records the user's identity on the root commit", async () => {
    const { store, root } = await setup();
    const author = await store.run(["log", "-1", "--format=%an <%ae>", root.commit]);
    expect(author).toBe("Test User <test@example.com>");
  });
});

describe("materialize", () => {
  it("writes the tree into a plain directory without .git", async () => {
    const { ws } = await setup({ "src/x.ts": "export const x = 1;\n", "README.md": "r\n" });
    expect(await readFile(join(ws, "src/x.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("refuses a non-empty directory", async () => {
    const { store, root } = await setup();
    const ws = await tempDir("turtle-ws-");
    await writeFile(join(ws, "junk"), "x");
    await expect(store.materialize(root.commit, ws, store.indexFileFor("b2"))).rejects.toThrow(
      /not empty/,
    );
  });
});

describe("snapshot", () => {
  it("returns null when nothing changed and allowUnchanged is false", async () => {
    const { store, root, ws, indexFile } = await setup();
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "micro",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
    });
    expect(res).toBeNull();
  });

  it("creates a commit with the same tree when allowUnchanged is true", async () => {
    const { store, root, ws, indexFile } = await setup();
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "semantic",
      identity: AGENT_IDENTITY,
      allowUnchanged: true,
    });
    expect(res).not.toBeNull();
    expect(res?.changed).toBe(false);
    expect(res?.tree).toBe(root.tree);
    expect(res?.commit).not.toBe(root.commit);
    expect(res?.stat).toEqual({ filesChanged: 0, linesAdded: 0, linesDeleted: 0 });
  });

  it("records edits, additions, deletions and diff stats", async () => {
    const { store, root, ws, indexFile } = await setup({
      "keep.txt": "1\n2\n3\n",
      "gone.txt": "bye\n",
    });
    await writeFiles(ws, { "keep.txt": "1\nTWO\n3\n4\n", "added dir/new file.txt": "n\n" });
    await rm(join(ws, "gone.txt"));
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "edit",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
    });
    expect(res?.changed).toBe(true);
    expect(await lsTree(store, res?.tree ?? "")).toEqual(["added dir/new file.txt", "keep.txt"]);
    // keep.txt: +2 -1, new: +1, gone: -1
    expect(res?.stat).toEqual({ filesChanged: 3, linesAdded: 3, linesDeleted: 2 });
    const diff = await store.diff(root.tree, res?.tree ?? "", ["keep.txt"]);
    expect(diff).toContain("+TWO");
    expect(diff).not.toContain("gone.txt");
  });

  it("honors .gitignore inside the workspace", async () => {
    const { store, root, ws, indexFile } = await setup({ ".gitignore": "node_modules/\n" });
    await writeFiles(ws, { "node_modules/pkg/index.js": "x", "src/a.ts": "a" });
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "m",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
    });
    expect(await lsTree(store, res?.tree ?? "")).toEqual([".gitignore", "src/a.ts"]);
  });

  it("counts binary files without line numbers", async () => {
    const { store, root, ws, indexFile } = await setup();
    await writeFiles(ws, { "img.bin": Buffer.from([0, 1, 2, 0, 255, 0]) });
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "m",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
    });
    expect(res?.stat).toEqual({ filesChanged: 1, linesAdded: 0, linesDeleted: 0 });
  });

  it("chains snapshots and moves the branch ref with compare-and-swap", async () => {
    const { store, root, ws, indexFile } = await setup();
    const ref = `${BRANCH_REF_PREFIX}b1`;
    await writeFiles(ws, { "one.txt": "1\n" });
    const first = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "first",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
      ref: { name: ref, expectedOld: null },
    });
    expect(await store.readRef(ref)).toBe(first?.commit);

    await writeFiles(ws, { "two.txt": "2\n" });
    const second = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: first?.commit ?? "", tree: first?.tree ?? "" },
      message: "second",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
      ref: { name: ref, expectedOld: first?.commit ?? null },
    });
    expect(await store.readRef(ref)).toBe(second?.commit);
    expect((await store.readCommit(second?.commit ?? "")).parents).toEqual([first?.commit]);
    expect(second?.stat.filesChanged).toBe(1);

    // A stale expectation is rejected and leaves the ref alone.
    await writeFiles(ws, { "three.txt": "3\n" });
    await expect(
      store.snapshot({
        workTree: ws,
        indexFile,
        parent: { commit: first?.commit ?? "", tree: first?.tree ?? "" },
        message: "stale",
        identity: AGENT_IDENTITY,
        allowUnchanged: false,
        ref: { name: ref, expectedOld: first?.commit ?? null },
      }),
    ).rejects.toBeInstanceOf(RefConflictError);
    expect(await store.readRef(ref)).toBe(second?.commit);
  });

  it("keeps the user's repository status untouched", async () => {
    const { repo, store, root, ws, indexFile } = await setup();
    const before = await git(["status", "--porcelain=v1", "--branch"], { cwd: repo });
    await writeFiles(ws, { "x.txt": "x\n" });
    await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: "m",
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
      ref: { name: `${BRANCH_REF_PREFIX}b1`, expectedOld: null },
    });
    expect(await git(["status", "--porcelain=v1", "--branch"], { cwd: repo })).toBe(before);
    expect(await git(["branch", "--list"], { cwd: repo })).toBe("* main");
  });
});

describe("refs, commits and blobs", () => {
  it("round-trips node trailers through a commit", async () => {
    const { store, root, ws, indexFile } = await setup();
    await writeFiles(ws, { "f.txt": "f\n" });
    const res = await store.snapshot({
      workTree: ws,
      indexFile,
      parent: { commit: root.commit, tree: root.tree },
      message: {
        title: "Add --json option parsing",
        body: "Parses --json and threads it into the exporter.",
        trailers: {
          "Turtle-Node": "k2pzq7wdabcd",
          "Turtle-Kind": "semantic",
          "Turtle-Status": "progress",
        },
      },
      identity: AGENT_IDENTITY,
      allowUnchanged: false,
    });
    const info = await store.readCommit(res?.commit ?? "");
    expect(info.node.title).toBe("Add --json option parsing");
    expect(info.node.body).toBe("Parses --json and threads it into the exporter.");
    expect(info.node.trailers).toEqual({
      "Turtle-Node": "k2pzq7wdabcd",
      "Turtle-Kind": "semantic",
      "Turtle-Status": "progress",
    });
    const author = await store.run(["log", "-1", "--format=%an <%ae>", info.sha]);
    expect(author).toBe("turtle-agent <agent@turtle.invalid>");
  });

  it("lists and deletes refs by prefix", async () => {
    const { store, root } = await setup();
    await store.updateRef(`${SNAPSHOT_REF_PREFIX}good`, root.commit, null);
    await store.updateRef(`${BRANCH_REF_PREFIX}b9`, root.commit, null);
    expect(await store.listRefs(SNAPSHOT_REF_PREFIX)).toEqual([
      { ref: `${SNAPSHOT_REF_PREFIX}good`, sha: root.commit },
    ]);
    await store.deleteRef(`${SNAPSHOT_REF_PREFIX}good`, root.commit);
    expect(await store.listRefs(SNAPSHOT_REF_PREFIX)).toEqual([]);
    expect(await store.readRef(`${SNAPSHOT_REF_PREFIX}good`)).toBeNull();
  });

  it("stores artifacts as blobs", async () => {
    const { store } = await setup();
    const dir = await tempDir();
    const content = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
    await writeFile(join(dir, "shot.png"), content);
    const sha = await store.hashFile(join(dir, "shot.png"));
    expect(await store.readBlob(sha)).toEqual(content);
  });
});
