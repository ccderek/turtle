import { resolve } from "node:path";
import { OpsError, Project } from "@turtle/core";
import { CliError } from "../context.js";
import { c } from "../render.js";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OpsError) throw new CliError(err.message);
    throw err;
  }
}

/** The project for `cwd`: a project dir, or a code repository attached to one. */
export async function requireProject(cwd: string): Promise<Project> {
  const p = await call(() => Project.find(cwd));
  if (!p)
    throw new CliError(
      `no turtle project here: run \`turtle init\` in a repository, or \`turtle project create\``,
    );
  return p;
}

export async function projectCreateCommand(
  cwd: string,
  dir: string,
  o: { source?: string[]; name?: string },
): Promise<string[]> {
  const sources = (o.source ?? []).map((s) => resolve(cwd, s));
  const p = await call(() =>
    Project.create(resolve(cwd, dir), { sources, ...(o.name ? { name: o.name } : {}) }),
  );
  const out = [`created project ${c.bold(p.config.name)} at ${p.dir}`];
  for (const s of p.config.sources) out.push(`  source ${c.bold(s.id)}  ${s.path}`);
  if (!sources.length) out.push(c.dim("  no sources yet: turtle project add-source <repo>"));
  out.push("", `next: ${c.bold(`cd ${p.dir} && turtle ui`)}`);
  p.close();
  return out;
}

export async function projectAddSourceCommand(
  cwd: string,
  path: string,
  o: { id?: string },
): Promise<string[]> {
  const p = await requireProject(cwd);
  try {
    const s = await call(() => p.addSource(resolve(cwd, path), o.id));
    return [`added source ${c.bold(s.id)}  ${s.path}`];
  } finally {
    p.close();
  }
}

export async function projectShowCommand(cwd: string): Promise<string[]> {
  const p = await requireProject(cwd);
  try {
    const goals = p.db.listConcepts({ kind: "goal" });
    const tasks = p.db.listConcepts({ kind: "task" });
    return [
      `${c.bold(p.config.name)}  ${p.dir}`,
      `member  ${p.identity.name} (${p.identity.memberId}, replica ${p.identity.replicaId})`,
      ...p.config.sources.map((s) => `source  ${c.bold(s.id)}  ${s.path}`),
      ...p.config.resources.map((r) => `resource  ${r.name} (${r.kind})`),
      `graph   ${goals.length} goals, ${tasks.length} tasks, ${p.db.listOps().length} operations`,
    ];
  } finally {
    p.close();
  }
}

export async function projectRebuildCommand(cwd: string): Promise<string[]> {
  const p = await requireProject(cwd);
  try {
    const n = await p.rebuild();
    return [`rebuilt the graph view from ${n} operations`];
  } finally {
    p.close();
  }
}
