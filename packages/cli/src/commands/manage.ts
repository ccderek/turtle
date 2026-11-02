import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  newId,
  reconcile,
  runGit,
  SNAPSHOT_REF_PREFIX,
  type TurtleNode,
} from "@turtle/core";
import { CliError, type Context, resolveBranch, resolveNode, shortIds } from "../context.js";
import { c, firstLine } from "../render.js";

// ------------------------------------------------------------------- init

export async function initCommand(ctx: Context): Promise<string[]> {
  const out: string[] = [`turtle state: ${ctx.store.turtleDir}`];
  const root = ctx.store.topLevel ?? ctx.cwd;
  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) {
    out.push(`config: ${configPath} (kept)`);
  } else {
    const dockerOk = hasDocker();
    const config = {
      agent: { model: DEFAULT_CONFIG.agent.model, maxBudgetUsd: DEFAULT_CONFIG.agent.maxBudgetUsd },
      sandbox: { mode: dockerOk ? "docker" : "none" },
      workspace: { copyIgnored: [".env"] },
      tests: {},
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    out.push(`config: ${configPath} (created; sandbox ${config.sandbox.mode})`);
    if (!dockerOk)
      out.push(c.yellow("docker not found: agents run as plain child processes (--sandbox none)"));
  }
  out.push("", `next: ${c.bold('turtle run "<task>"')}`);
  return out;
}

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- checkout

export async function checkoutCommand(ctx: Context, ref: string, dir?: string): Promise<string[]> {
  const n = resolveNode(ctx.db, ref);
  const target = resolve(ctx.cwd, dir ?? `turtle-${shortIds(ctx.db)(n.id)}`);
  const indexFile = join(ctx.store.turtleDir, "index", `checkout-${newId()}`);
  try {
    await ctx.store.materialize(n.commitSha, target, indexFile);
  } finally {
    await rm(indexFile, { force: true });
  }
  return [`checked out ${n.id} into ${target}`];
}

// -------------------------------------------------------------------- tag

export async function tagCommand(ctx: Context, ref: string, name: string): Promise<string[]> {
  if (!/^[\w.-]+$/.test(name)) throw new CliError(`invalid snapshot name: ${name}`);
  const n = resolveNode(ctx.db, ref);
  const refName = `${SNAPSHOT_REF_PREFIX}${name}`;
  const old = await ctx.store.readRef(refName);
  await ctx.store.updateRef(refName, n.commitSha, old);
  ctx.db.transaction(() => {
    ctx.db.putSnapshot(name, n.id);
    const tags = n.tags.includes("snapshot") ? n.tags : [...n.tags, "snapshot"];
    ctx.db.updateNode(n.id, { tags });
    ctx.db.appendEvent({
      actorType: "human",
      actorId: null,
      type: "tag",
      branchId: n.branchId,
      nodeId: n.id,
      agentId: null,
      payload: { name, moved: Boolean(old) },
    });
  });
  return [`snapshot ${c.bold(name)} → ${n.id}${old ? " (moved)" : ""}`];
}

// ----------------------------------------------------------------- export

/** Semantic nodes from the original root to `n`, oldest first (crossing fork points). */
function semanticPath(ctx: Context, n: TurtleNode): { path: TurtleNode[]; root: TurtleNode } {
  const path: TurtleNode[] = [];
  let cur: TurtleNode | null = n;
  let root: TurtleNode = n;
  while (cur) {
    if (cur.kind === "semantic") path.push(cur);
    root = cur;
    cur = cur.parents[0] ? ctx.db.getNode(cur.parents[0]) : null;
  }
  return { path: path.reverse(), root };
}

export async function exportCommand(
  ctx: Context,
  ref: string,
  o: { branch: string; message?: string },
): Promise<string[]> {
  const { store, db } = ctx;
  const n = resolveNode(db, ref);
  const branchRef = `refs/heads/${o.branch}`;
  const check = await runGit(["check-ref-format", branchRef], { okCodes: [0, 1] });
  if (check.exitCode !== 0) throw new CliError(`invalid branch name: ${o.branch}`);
  if (await store.readRef(branchRef)) throw new CliError(`branch ${o.branch} already exists`);

  const { path, root } = semanticPath(ctx, n);
  const rootCommit = await store.readCommit(root.commitSha);
  const base = rootCommit.parents[0];
  const title = o.message ?? firstLine(n.summary) ?? "turtle export";
  const body = path.map((p) => `- ${firstLine(p.summary)}`).join("\n");
  const message = `${title}\n\n${body ? `${body}\n\n` : ""}Turtle-Export: ${n.id}\n`;
  const identity = await store.userIdentity();
  const commit = await store.commitTree(n.treeSha, base ? [base] : [], message, identity);
  await store.updateRef(branchRef, commit, null);
  db.appendEvent({
    actorType: "human",
    actorId: null,
    type: "export",
    branchId: n.branchId,
    nodeId: n.id,
    agentId: null,
    payload: { branch: o.branch, commit },
  });
  const out = [
    `exported ${n.id} as branch ${c.bold(o.branch)} (${commit.slice(0, 10)}, one commit on ${base?.slice(0, 10) ?? "no parent"})`,
  ];
  if (root.summary?.includes("uncommitted")) {
    out.push(
      c.yellow("note: the run started from uncommitted changes; they are part of this commit"),
    );
  }
  return out;
}

// ------------------------------------------------------------------- stop

export async function stopCommand(ctx: Context, branchRef: string): Promise<string[]> {
  const b = resolveBranch(ctx.db, branchRef);
  const agents = ctx.db.listAgents({ branchId: b?.id ?? "", status: "running" });
  if (!agents.length) throw new CliError(`branch ${branchRef} has no running agent`);
  const out: string[] = [];
  for (const a of agents) {
    const pidFile = join(ctx.store.turtleDir, "run", `${a.id}.pid`);
    const pid = existsSync(pidFile) ? Number(await readFile(pidFile, "utf8")) : a.pid;
    if (!pid) continue;
    try {
      process.kill(pid, "SIGINT");
      out.push(`interrupt sent to agent ${a.id} (pid ${pid})`);
    } catch (err) {
      out.push(c.red(`could not signal pid ${pid}: ${(err as Error).message}`));
    }
  }
  return out;
}

// --------------------------------------------------------------------- gc

export async function gcCommand(
  ctx: Context,
  o: { all?: boolean; dryRun?: boolean },
): Promise<string[]> {
  const out: string[] = [];
  const removable = new Set(["done", "killed", "failed", ...(o.all ? ["idle"] : [])]);
  for (const b of ctx.db.listBranches()) {
    if (!removable.has(b.status) || !b.workspacePath || !existsSync(b.workspacePath)) continue;
    if (!o.dryRun) {
      await rm(b.workspacePath, { recursive: true, force: true });
      await rm(ctx.store.indexFileFor(b.id), { force: true });
    }
    out.push(
      `${o.dryRun ? "would remove" : "removed"} workspace of ${b.id} (${b.status}): ${b.workspacePath}`,
    );
  }
  if (!out.length) out.push(c.dim("nothing to remove"));
  else if (!o.dryRun)
    out.push(c.dim("content stays in git; `turtle run --from` re-creates a workspace when needed"));
  return out;
}

// ----------------------------------------------------------------- doctor

export async function doctorCommand(ctx: Context): Promise<{ lines: string[]; ok: boolean }> {
  const { store, db } = ctx;
  const out: string[] = [];
  const problems: string[] = [];
  const report = await reconcile(store, db);
  if (report.importedNodes.length)
    out.push(c.yellow(`imported ${report.importedNodes.length} node(s) from git`));
  if (report.failedAgents.length)
    out.push(c.yellow(`marked ${report.failedAgents.length} dead agent(s) failed`));

  for (const b of db.listBranches()) {
    const sha = await store.readRef(b.ref);
    const head = b.headNodeId ? db.getNode(b.headNodeId) : null;
    if (!sha) problems.push(`branch ${b.id}: ref ${b.ref} is missing`);
    else if (head && head.commitSha !== sha)
      problems.push(
        `branch ${b.id}: ref ${sha.slice(0, 10)} ≠ head node commit ${head.commitSha.slice(0, 10)}`,
      );
    if (
      (b.status === "running" || b.status === "idle") &&
      b.workspacePath &&
      !existsSync(b.workspacePath)
    ) {
      out.push(c.dim(`branch ${b.id}: workspace missing (re-created on next run)`));
    }
  }
  const nodes = db.listNodes();
  for (const n of nodes) {
    const res = await runGit(["cat-file", "-e", `${n.commitSha}^{commit}`], {
      gitDir: store.commonDir,
      okCodes: [0, 1, 128],
    });
    if (res.exitCode !== 0) problems.push(`node ${n.id}: commit ${n.commitSha} missing from git`);
  }
  await mkdir(store.turtleDir, { recursive: true });
  out.push(`${db.listBranches().length} branches, ${nodes.length} nodes checked`);
  out.push(...problems.map((p) => c.red(`✗ ${p}`)));
  out.push(
    problems.length
      ? c.red(`${problems.length} problem(s)`)
      : c.green("✓ git and the database agree"),
  );
  return { lines: out, ok: problems.length === 0 };
}
