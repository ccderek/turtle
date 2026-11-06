import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/git/exec.js";
import { GitStore } from "../src/git/store.js";
import { GraphDb } from "../src/project/graph-db.js";
import { canonicalJson, causalOrder, OPS_REF_PREFIX, operationId } from "../src/project/oplog.js";
import { PROJECT_FILE, Project, StaleEditError } from "../src/project/project.js";
import type { Actor, Operation } from "../src/project/types.js";
import { makeRepo, tempDir } from "./helpers.js";

async function setup() {
  const home = await tempDir("turtle-home-");
  const a = await makeRepo({ "a.txt": "a\n" });
  const b = await makeRepo({ "b.txt": "b\n" });
  const dir = join(await tempDir("turtle-proj-"), "perf-lab");
  const p = await Project.create(dir, { sources: [a, b], home });
  return { home, a, b, dir, p };
}

const agent = (p: Project): Actor => ({
  type: "agent",
  id: "agent1",
  onBehalfOf: p.identity.memberId,
});

describe("project", () => {
  it("creates a project repository with sources, identity and pointers", async () => {
    const { home, a, b, dir, p } = await setup();
    expect(p.config.sources.map((s) => s.path)).toEqual([a, b]);
    expect(p.config.name).toBe("perf-lab");
    const committed = await git(["show", `HEAD:${PROJECT_FILE}`], { cwd: dir });
    expect(JSON.parse(committed).sources).toHaveLength(2);
    const identity = JSON.parse(await readFile(join(home, "identity.json"), "utf8"));
    expect(identity.memberId).toMatch(/^m_/);
    expect(p.identity).toEqual(identity);

    // Found from the project dir and from an attached source.
    expect((await Project.find(join(dir), { home }))?.dir).toBe(dir);
    expect((await Project.find(a, { home }))?.dir).toBe(dir);
    // A source path cannot be attached twice.
    await expect(p.addSource(b)).rejects.toThrow(/already a source/);
  });

  it("gives a bare code repository its own one-source project, once", async () => {
    const home = await tempDir("turtle-home-");
    const repo = await makeRepo();
    const store = await GitStore.open(repo);
    const p1 = await Project.ensureForRepo(store, { home });
    expect(p1.dir.startsWith(join(home, "projects"))).toBe(true);
    expect(p1.config.sources.map((s) => s.path)).toEqual([repo]);
    const p2 = await Project.ensureForRepo(store, { home });
    expect(p2.dir).toBe(p1.dir);
  });

  it("records concepts as operations committed to the replica's ref", async () => {
    const { p } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "Measure model A" });
    const task = await p.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Set up the phone",
    });
    expect(task).toMatchObject({ status: "todo", dependsOn: [], version: 1, createdBy: p.me });
    const updated = await p.updateConcept(task.id, { status: "running", body: "adb + clocks" });
    expect(updated).toMatchObject({ version: 2, status: "running", body: "adb + clocks" });
    await p.link(task.id, "evidence", { type: "checkpoint", id: "cp1" });

    const ref = `${OPS_REF_PREFIX}${p.identity.memberId}/${p.identity.replicaId}`;
    const tip = await p.store.readRef(ref);
    expect(tip).toBeTruthy();
    const log = await git(["log", "--format=%s", ref], { cwd: p.dir });
    expect(log.split("\n")).toEqual([
      "turtle ops 4-4",
      "turtle ops 3-3",
      "turtle ops 2-2",
      "turtle ops 1-1",
    ]);
    expect(p.db.listLinks({ from: task.id })).toMatchObject([
      { rel: "evidence", to: { id: "cp1" } },
    ]);
    expect(p.db.listConcepts({ parentId: goal.id }).map((c) => c.id)).toEqual([task.id]);
  });

  it("rebuilds the exact same view from the refs", async () => {
    const { p, dir, home } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    const t = await p.createConcept({ kind: "task", parentId: goal.id, title: "T" });
    await p.updateConcept(t.id, { title: "T2" }, { actor: agent(p) });
    await p.dropConcept(t.id);
    await p.link(goal.id, "evidence", { type: "output", id: "o1" });
    const before = p.db.snapshot();
    expect(await p.rebuild()).toBe(5);
    expect(p.db.snapshot()).toEqual(before);

    // A lost DB is imported from the refs on open.
    p.close();
    const fresh = GraphDb.open(join(dir, ".git", "turtle", "project.db"));
    fresh.clear();
    fresh.close();
    const reopened = await Project.open(dir, { home });
    expect(reopened.db.snapshot()).toEqual(before);
  });

  it("rejects an agent's stale edit of a field a member changed, but lets the member win", async () => {
    const { p } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    const t = await p.createConcept({ kind: "task", parentId: goal.id, title: "Plan" });
    const seenByAgent = t.version;
    await p.updateConcept(t.id, { title: "Plan: 3 runs" }); // the member edits
    await expect(
      p.updateConcept(t.id, { title: "Plan: 5 runs" }, { base: seenByAgent, actor: agent(p) }),
    ).rejects.toBeInstanceOf(StaleEditError);
    // Other fields are fine.
    await p.updateConcept(t.id, { body: "details" }, { base: seenByAgent, actor: agent(p) });
    // An agent edit followed by a stale member edit: the member wins.
    const v = p.getConcept(t.id)?.version ?? 0;
    await p.updateConcept(t.id, { body: "agent text" }, { actor: agent(p) });
    const after = await p.updateConcept(t.id, { body: "member text" }, { base: v });
    expect(after.body).toBe("member text");
    expect(after.title).toBe("Plan: 3 runs");
  });

  it("validates structure", async () => {
    const { p } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    await expect(p.createConcept({ kind: "task", parentId: null, title: "T" })).rejects.toThrow(
      /needs a parent/,
    );
    await expect(p.createConcept({ kind: "goal", parentId: goal.id, title: "G2" })).rejects.toThrow(
      /no parent/,
    );
    await expect(p.createConcept({ kind: "task", parentId: goal.id, title: "  " })).rejects.toThrow(
      /title/,
    );
    const t1 = await p.createConcept({ kind: "task", parentId: goal.id, title: "T1" });
    const t2 = await p.createConcept({ kind: "task", parentId: t1.id, title: "T2" });
    await expect(p.updateConcept(t1.id, { parentId: t2.id })).rejects.toThrow(/under itself/);
    await expect(
      p.createConcept({ kind: "task", parentId: goal.id, title: "T3", dependsOn: [goal.id] }),
    ).rejects.toThrow(/not a task/);
  });

  it("undoes a batch with an inverse batch", async () => {
    const { p } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    const t = await p.createConcept({ kind: "task", parentId: goal.id, title: "T", body: "old" });
    await p.updateConcept(t.id, { body: "new", status: "running" });
    const setOp = p.db.listOps({ concept: t.id }).at(-1);
    await p.undo(setOp?.id as string);
    expect(p.getConcept(t.id)).toMatchObject({ body: "old", status: "todo" });

    const createOp = p.db.listOps({ concept: t.id })[0];
    await p.undo(createOp?.id as string);
    expect(p.getConcept(t.id)?.dropped).toBe(true);
    const dropOp = p.db.listOps({ concept: t.id }).at(-1);
    await p.undo(dropOp?.id as string);
    expect(p.getConcept(t.id)?.dropped).toBe(false);
  });

  it("serializes writers across processes sharing a replica", async () => {
    const { p, dir, home } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    const other = await Project.open(dir, { home }); // a second process: same replica, own handles
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        p.createConcept({ kind: "task", parentId: goal.id, title: `p${i}` }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        other.createConcept({ kind: "task", parentId: goal.id, title: `o${i}` }),
      ),
    ]);
    const ops = p.db.listOps();
    expect(ops).toHaveLength(13);
    expect(new Set(ops.map((o) => o.seq)).size).toBe(13);
    expect(await p.rebuild()).toBe(13);
    expect(p.db.listConcepts({ kind: "task" })).toHaveLength(12);
    expect(existsSync(join(dir, ".git", "turtle", "ops.lock"))).toBe(false);
  });

  it("repairs a ref left behind by a crash between the DB write and the ref update", async () => {
    const { p } = await setup();
    const goal = await p.createConcept({ kind: "goal", parentId: null, title: "G" });
    const ref = p.log.ref;
    const first = await p.store.readRef(ref);
    await p.createConcept({ kind: "task", parentId: goal.id, title: "T" });
    const second = await p.store.readRef(ref);
    await p.store.updateRef(ref, first as string, second); // simulate: DB ahead of the ref
    expect(await p.log.repair()).toBe("ref-moved");
    expect(await p.store.readRef(ref)).toBe(second);
  });
});

describe("operation log primitives", () => {
  it("hashes canonical JSON independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    const body = {
      replica: "m/r",
      seq: 1,
      deps: {},
      actor: { type: "member" as const, id: "m" },
      at: "2026-01-01T00:00:00.000Z",
      change: { kind: "restore" as const, id: "c_x" },
    };
    expect(operationId(body)).toBe(operationId({ ...body, deps: {} }));
    expect(operationId(body)).not.toBe(operationId({ ...body, seq: 2 }));
  });

  it("orders operations causally across replicas", () => {
    const op = (
      replica: string,
      seq: number,
      at: string,
      deps: Record<string, number> = {},
    ): Operation => ({
      id: `${replica}${seq}`,
      replica,
      seq,
      deps,
      actor: { type: "member", id: replica },
      at,
      change: { kind: "restore", id: "c" },
    });
    // b1 was written after seeing a2, although its clock is earlier.
    const ops = [op("a", 2, "t3"), op("b", 1, "t1", { a: 2 }), op("a", 1, "t2")];
    expect(causalOrder(ops).map((o) => o.id)).toEqual(["a1", "a2", "b1"]);
  });
});
