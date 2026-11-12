import { OpsError } from "../ops.js";
import { runScript, type ScriptSandbox } from "../run/script.js";
import type { Project } from "./project.js";
import type { Actor, CheckResult, Concept } from "./types.js";

export const CHECK_TIMEOUT_MS = 60_000;

/**
 * Run one check against a working directory (architecture §3.7), in the task's sandbox.
 * The script lives outside the agent's reach; exit code 0 passes, the output explains.
 */
export async function runCheck(
  check: Concept,
  cwd: string,
  o: { timeoutMs?: number; env?: Record<string, string>; sandbox?: ScriptSandbox } = {},
): Promise<{ ok: boolean; output: string; ms: number }> {
  if (check.kind !== "check" || !check.file || !check.script)
    throw new OpsError(`${check.id} is not a check`);
  const r = await runScript({
    file: check.file,
    script: check.script,
    cwd,
    env: { ...(o.env ?? {}), TURTLE_CHECK: check.id },
    timeoutMs: o.timeoutMs ?? CHECK_TIMEOUT_MS,
    ...(o.sandbox ? { sandbox: o.sandbox } : {}),
  });
  return { ok: r.ok, output: r.output, ms: r.ms };
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
  o: {
    checkpointId?: string | null;
    actor?: Actor;
    timeoutMs?: number;
    sandbox?: ScriptSandbox;
  } = {},
): Promise<TaskCheckRun[]> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  const checks = project.checksInScope(taskId);
  if (!checks.length) return [];
  const out: TaskCheckRun[] = [];
  for (const check of checks) {
    const r = await runCheck(check, cwd, {
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.sandbox ? { sandbox: o.sandbox } : {}),
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
