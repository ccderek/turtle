import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type FakeScript,
  fakeLauncher,
  git,
  HeuristicSummarizer,
  mergeConfig,
  type RunOptions,
  RunSession,
} from "@turtle/core";
import { describe, expect, it } from "vitest";
import { logCommand, showCommand, statsCommand, statusCommand } from "../src/commands/inspect.js";
import {
  checkoutCommand,
  doctorCommand,
  exportCommand,
  gcCommand,
  tagCommand,
} from "../src/commands/manage.js";
import { CliError, type Context, openContext, resolveNode } from "../src/context.js";

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  NO_COLOR: "1",
});
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (lines: string[]) => lines.map((l) => l.replace(ANSI, ""));

async function scenario() {
  const repo = await mkdtemp(join(tmpdir(), "turtle-cli-"));
  process.env.TURTLE_HOME = `${repo}-home`;
  await git(["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], {
    cwd: repo,
  });
  const ctx = await openContext(repo);
  ctx.config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const run = async (prompt: string, script: FakeScript, extra: Partial<RunOptions> = {}) => {
    const s = await RunSession.start(
      {
        store: ctx.store,
        db: ctx.db,
        config: ctx.config,
        summarizer: new HeuristicSummarizer(),
        launcher: fakeLauncher(script),
      },
      { prompt, ...extra },
    );
    return { s, out: await s.done };
  };
  const first = await run("task", async (a) => {
    await a.edit("b.txt", "b\n");
    await a.checkpoint("Add b");
    await a.edit("c.txt", "c\n");
    await a.checkpoint("Which name for d?", "need_decision");
    await a.finish();
  });
  const addB = ctx.db.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] })[0];
  const fork = await run(
    "other way",
    async (a) => {
      await a.edit("x.txt", "x\n");
      await a.checkpoint("Add x instead", "done");
      await a.finish();
    },
    { from: addB?.id ?? "", name: "alt" },
  );
  return { repo, ctx, first, fork, addB: addB as NonNullable<typeof addB> };
}

describe("turtle CLI commands", () => {
  it("log draws the fork as a tree with branch labels", async () => {
    const { ctx } = await scenario();
    const lines = strip(logCommand(ctx, {}));
    expect(lines[0]).toMatch(/^◉ \w{4,} +root: HEAD [0-9a-f]{7}$/);
    expect(lines[1]).toMatch(/^◆ \w{4,} +progress +Add b +\+1 −0 1f$/);
    expect(lines[2]).toMatch(/^├─◆ \w{4,} +need_decision +Which name for d\? .*← \w{4,} idle$/);
    expect(lines[3]).toMatch(/^└─◆ \w{4,} +done +Add x instead .*← alt \w{4,} done$/);
    expect(lines).toHaveLength(4);
    const all = strip(logCommand(ctx, { all: true }));
    expect(all.filter((l) => l.includes("micro: after Edit"))).toHaveLength(3);
  });

  it("status lists what needs a human answer", async () => {
    const { ctx } = await scenario();
    const text = strip(statusCommand(ctx)).join("\n");
    expect(text).toContain("needs you (1)");
    expect(text).toMatch(/need_decision +\w+ +Which name for d\?/);
    expect(text).toMatch(/turtle run --from \w+ "<answer>"/);
  });

  it("resolves prefixes, snapshots and branches, and rejects unknown refs", async () => {
    const { ctx, addB, fork } = await scenario();
    expect(resolveNode(ctx.db, addB.id.slice(0, 6)).id).toBe(addB.id);
    expect(resolveNode(ctx.db, "alt").id).toBe(ctx.db.getBranch(fork.s.branchId)?.headNodeId);
    await tagCommand(ctx, addB.id.slice(0, 6), "good");
    expect(resolveNode(ctx.db, "good").id).toBe(addB.id);
    expect(await ctx.store.readRef("refs/turtle/snapshots/good")).toBe(addB.commitSha);
    expect(() => resolveNode(ctx.db, "zzzzzz")).toThrow(CliError);
  });

  it("show prints the diff since the previous checkpoint and the transcript", async () => {
    const { ctx, first } = await scenario();
    const decision = ctx.db.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] })[1];
    const text = strip(
      await showCommand(ctx, decision?.id ?? "", { diff: true, transcript: true }),
    ).join("\n");
    expect(text).toContain("changes  since last checkpoint: 1 files  +1 −0");
    expect(text).toContain("+c");
    expect(text).not.toContain("+b");
    expect(text).toContain("→ mcp__turtle__checkpoint");
  });

  it("checkout and export write the node's files", async () => {
    const { ctx, repo, fork } = await scenario();
    const head = ctx.db.getBranch(fork.s.branchId)?.headNodeId ?? "";
    const co = `${repo}-co`;
    await checkoutCommand(ctx, head, co);
    expect(await readFile(join(co, "x.txt"), "utf8")).toBe("x\n");
    await exportCommand(ctx, head, { branch: "feat/x" });
    const files = await git(["ls-tree", "-r", "--name-only", "feat/x"], { cwd: repo });
    expect(files.split("\n")).toEqual(["a.txt", "b.txt", "x.txt"]);
    const msg = await git(["log", "-1", "--format=%B", "feat/x"], { cwd: repo });
    expect(msg).toContain("- Add b\n- Add x instead");
    expect(await git(["rev-parse", "feat/x^"], { cwd: repo })).toBe(
      await git(["rev-parse", "main"], { cwd: repo }),
    );
    await expect(exportCommand(ctx, head, { branch: "feat/x" })).rejects.toThrow(/already exists/);
  });

  it("gc removes finished workspaces and keeps idle ones unless --all", async () => {
    const { ctx, first, fork } = await scenario();
    const finished = ctx.db.getBranch(fork.s.branchId)?.workspacePath ?? "";
    const idle = ctx.db.getBranch(first.s.branchId)?.workspacePath ?? "";
    await gcCommand(ctx, {});
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(idle)).toBe(true);
    await gcCommand(ctx, { all: true });
    expect(existsSync(idle)).toBe(false);
  });

  it("doctor passes, then reports a moved ref", async () => {
    const { ctx, first } = await scenario();
    expect((await doctorCommand(ctx)).ok).toBe(true);
    const branch = ctx.db.getBranch(first.s.branchId);
    const root = ctx.db.getNode(branch?.rootNodeId ?? "");
    await ctx.store.updateRef(
      branch?.ref ?? "",
      root?.commitSha ?? "",
      await ctx.store.readRef(branch?.ref ?? ""),
    );
    const res = await doctorCommand(ctx as Context);
    expect(res.ok).toBe(false);
    expect(strip(res.lines).join("\n")).toMatch(/ref [0-9a-f]+ ≠ head node commit/);
  });

  it("stats counts nodes per run and evaluates criteria", async () => {
    const { ctx } = await scenario();
    const { lines } = statsCommand(ctx, { criteria: true });
    const text = strip(lines).join("\n");
    expect(text).toMatch(/done +[\d.]+ +\d+ +2 +2 +0/);
    expect(text).toContain("FAIL E1 ≥5 real runs finished");
    expect(text).toContain("PASS E3 snapshot p95 < 300 ms");
  });
});
