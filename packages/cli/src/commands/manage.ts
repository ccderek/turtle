import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  exportNode,
  newId,
  OpsError,
  Project,
  reconcile,
  requestStop,
  runGit,
  tagNode,
} from "@turtle/core";
import { CliError, type Context, resolveBranch, resolveNode, shortIds } from "../context.js";
import { c } from "../render.js";
import { credentialHint } from "./run.js";

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
  const project = await Project.ensureForRepo(ctx.store);
  out.push(`project: ${project.dir} (${project.config.sources.length} source)`);
  project.close();
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
  const n = resolveNode(ctx.db, ref);
  const { moved } = await opsCall(() => tagNode(ctx.store, ctx.db, n, name));
  return [`snapshot ${c.bold(name)} → ${n.id}${moved ? " (moved)" : ""}`];
}

// ----------------------------------------------------------------- export

export async function exportCommand(
  ctx: Context,
  ref: string,
  o: { branch: string; message?: string },
): Promise<string[]> {
  const n = resolveNode(ctx.db, ref);
  const r = await opsCall(() => exportNode(ctx.store, ctx.db, n, o));
  const out = [
    `exported ${n.id} as branch ${c.bold(r.branch)} (${r.commit.slice(0, 10)}, one commit on ${r.base?.slice(0, 10) ?? "no parent"})`,
  ];
  if (r.includesUncommitted) {
    out.push(
      c.yellow("note: the run started from uncommitted changes; they are part of this commit"),
    );
  }
  return out;
}

// ------------------------------------------------------------------- stop

export async function stopCommand(ctx: Context, branchRef: string): Promise<string[]> {
  const b = resolveBranch(ctx.db, branchRef);
  if (!b) throw new CliError(`unknown branch: ${branchRef}`);
  const results = await opsCall(() => requestStop(ctx.store, ctx.db, b));
  return results.map((r) =>
    r.via === "none" ? c.red(`agent ${r.agentId}: ${r.detail}`) : `agent ${r.agentId}: ${r.detail}`,
  );
}

async function opsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new CliError(err.message);
    throw err;
  }
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
  const hint = credentialHint(ctx.config.sandbox.mode);
  out.push(hint ? c.yellow(`! ${hint}`) : c.dim("Claude credentials found in the environment"));
  out.push(...problems.map((p) => c.red(`✗ ${p}`)));
  out.push(
    problems.length
      ? c.red(`${problems.length} problem(s)`)
      : c.green("✓ git and the database agree"),
  );
  return { lines: out, ok: problems.length === 0 };
}
