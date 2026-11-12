import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { OpsError } from "../ops.js";
import type { Project } from "./project.js";
import type { Actor, CheckResult, Concept } from "./types.js";

const MAX_OUTPUT = 4000;
export const CHECK_TIMEOUT_MS = 60_000;

const INTERPRETER: Record<string, string> = {
  ".py": "python3",
  ".sh": "bash",
  ".js": "node",
  ".mjs": "node",
};

/** Variables that look like credentials never reach a check (it runs outside the sandbox). */
const SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL|_KEY$)/i;

/**
 * Run one check against a working directory (architecture §3.7). The script is written to
 * a fresh temporary directory, outside the agent's reach, and run with `cwd` as its working
 * directory. Exit code 0 passes; the output is the explanation.
 */
export async function runCheck(
  check: Concept,
  cwd: string,
  o: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; output: string; ms: number }> {
  if (check.kind !== "check" || !check.file || !check.script)
    throw new OpsError(`${check.id} is not a check`);
  const interpreter = INTERPRETER[extname(check.file).toLowerCase()];
  if (!interpreter) throw new OpsError(`no interpreter for ${check.file}`);
  const dir = await mkdtemp(join(tmpdir(), "turtle-check-"));
  const path = join(dir, check.file);
  const started = Date.now();
  try {
    await writeFile(path, check.script, { mode: 0o600 });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !SECRET.test(k)) env[k] = v;
    Object.assign(env, o.env ?? {}, { TURTLE_CHECK: check.id, PYTHONDONTWRITEBYTECODE: "1" });
    const { code, output, timedOut, error } = await run(
      interpreter,
      [path],
      cwd,
      env,
      o.timeoutMs ?? CHECK_TIMEOUT_MS,
    );
    const ms = Date.now() - started;
    if (error) return { ok: false, output: `could not run ${interpreter}: ${error}`, ms };
    if (timedOut)
      return {
        ok: false,
        output: `${clip(output)}\n(timed out after ${Math.round(ms / 1000)} s)`.trim(),
        ms,
      };
    return {
      ok: code === 0,
      output: clip(output) || (code === 0 ? "passed" : `exit code ${code}`),
      ms,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const add = (d: Buffer) => {
      output += d.toString("utf8");
      // Keep the tail: the end of a failing check's output explains it.
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, output, timedOut, error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUTPUT ? `…${t.slice(-MAX_OUTPUT)}` : t;
}

export interface TaskCheckRun {
  check: Concept;
  result: CheckResult;
}

/**
 * Run every active check in a task's scope against its working directory and record the
 * results on the task (`checkResults`). Returns them, failures first.
 */
export async function runTaskChecks(
  project: Project,
  taskId: string,
  cwd: string,
  o: { checkpointId?: string | null; actor?: Actor; timeoutMs?: number } = {},
): Promise<TaskCheckRun[]> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  const checks = project.checksInScope(taskId);
  if (!checks.length) return [];
  const out: TaskCheckRun[] = [];
  for (const check of checks) {
    const r = await runCheck(check, cwd, {
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      env: { TURTLE_TASK: taskId },
    });
    out.push({
      check,
      result: {
        ok: r.ok,
        at: new Date().toISOString(),
        checkpointId: o.checkpointId ?? null,
        output: r.output,
        ms: r.ms,
      },
    });
  }
  const results = { ...(project.getConcept(taskId)?.checkResults ?? {}) };
  for (const { check, result } of out) results[check.id] = result;
  await project.updateConcept(taskId, { checkResults: results }, o.actor ? { actor: o.actor } : {});
  return out.sort((a, b) => Number(a.result.ok) - Number(b.result.ok));
}

/** Checks in scope whose latest result on the task failed. */
export function failingChecks(project: Project, task: Concept): Concept[] {
  return project
    .checksInScope(task.id)
    .filter((c) => task.checkResults?.[c.id] && !task.checkResults[c.id]?.ok);
}

/** The text an agent gets in a checkpoint reply when checks fail. */
export function checkReplyNote(runs: TaskCheckRun[]): string | undefined {
  const failed = runs.filter((r) => !r.result.ok);
  if (!runs.length) return undefined;
  if (!failed.length) return `All ${runs.length} check(s) in scope pass.`;
  const lines = failed.map(
    (r) =>
      `- ${r.check.title} (${r.check.file}): ${r.result.output.split("\n").slice(-6).join("\n  ")}`,
  );
  return `${failed.length} of ${runs.length} check(s) FAILED. They are acceptance conditions set for this part of the project; you cannot change them. Fix the work and checkpoint again; the task cannot end done while a check fails:\n${lines.join("\n")}`;
}
