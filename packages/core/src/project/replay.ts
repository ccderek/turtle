import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { TurtleDb } from "../db/db.js";
import type { TurtleNode } from "../db/types.js";
import { runGit } from "../git/exec.js";
import { GitStore } from "../git/store.js";
import { OpsError } from "../ops.js";
import { INTERPRETER, runScript, type ScriptSandbox } from "../run/script.js";
import type { RunnerLauncher } from "../run/transport.js";
import { fakeLauncher } from "../testing/fake-runner.js";
import type { Project } from "./project.js";
import { expandOutputs, RECIPE_TIMEOUT_MS } from "./recipes.js";
import type { Actor, Concept, ReplaySpec, ReplayStep } from "./types.js";

/**
 * Path replay (architecture §3.7): redo the steps of a task — its checkpoints up to one —
 * on a new base (your repository now, the original start, or another checkpoint), with
 * other parameters. Code changes are applied as they were; results are never copied:
 * the task's recipe regenerates them, or an agent does. A step whose change no longer
 * applies, and results without a recipe, go to an agent that is told exactly what is left.
 */

const NOTE_MAX = 4000;
const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0]?.trim() ?? "";

export interface ReplayPlan {
  source: { taskId: string; nodeId: string };
  steps: ReplayStep[];
  /** The task's verified recipe, which regenerates the results. */
  recipe: Concept | null;
  /** Parameters (the recipe's defaults). */
  params: Record<string, string>;
  /** Result files: excluded from applied changes, regenerated instead. */
  outputs: string[];
  /** The original start, for replays onto it. */
  startNodeId: string;
}

function requireSingleSource(project: Project): void {
  if (project.config.sources.length > 1)
    throw new OpsError("replays are not supported yet in projects with several sources");
}

async function openSource(project: Project, task: Concept) {
  const ref = task.branches?.[0];
  const src = ref ? project.config.sources.find((s) => s.id === ref.source) : undefined;
  if (!ref || !src) throw new OpsError("the task has no run to replay");
  const store = await GitStore.open(src.path);
  const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
  return { store, db, branchId: ref.branch };
}

/** The task's output files (cited evidence and recipe outputs), which are regenerated. */
function outputsOf(project: Project, task: Concept, recipe: Concept | null): string[] {
  const outs = new Set<string>();
  for (const o of project.db.listConcepts({ parentId: task.id, kind: "output" }))
    if (o.path && !o.dropped) outs.add(o.path);
  if (recipe) for (const o of expandOutputs(recipe.outputs, recipe.params ?? {})) outs.add(o);
  return [...outs];
}

function excludes(outputs: string[]): string[] {
  return outputs.length ? ["--", ".", ...outputs.map((o) => `:(exclude)${o}`)] : [];
}

/** The steps a replay of `taskId` up to `nodeId` (default: its latest checkpoint) would take. */
export async function planReplay(
  project: Project,
  taskId: string,
  nodeId?: string,
): Promise<ReplayPlan> {
  requireSingleSource(project);
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") throw new OpsError(`${taskId} is not a task`);
  const target =
    nodeId ??
    project.db
      .listLinks({ from: taskId, rel: "evidence" })
      .filter((l) => l.to.type === "node")
      .at(-1)?.to.id;
  if (!target) throw new OpsError("the task has no checkpoint to replay");
  const recipe =
    project.recipesOf(taskId).find((r) => r.recipeState === "verified" && r.verification?.ok) ??
    null;
  const outputs = outputsOf(project, task, recipe);
  const { store, db, branchId } = await openSource(project, task);
  try {
    const branch = db.getBranch(branchId);
    const end = db.getNode(target);
    if (!branch || !end || end.branchId !== branch.id)
      throw new OpsError("that checkpoint is not on the task's branch");
    // Semantic checkpoints from the branch start to the target, oldest first.
    const path: TurtleNode[] = [];
    let cur: TurtleNode | null = end;
    while (cur && cur.id !== branch.rootNodeId) {
      if (cur.kind === "semantic") path.unshift(cur);
      cur = cur.parents[0] ? db.getNode(cur.parents[0]) : null;
    }
    const start = db.getNode(branch.rootNodeId ?? "");
    if (!start) throw new OpsError("the task's start is missing");
    const steps: ReplayStep[] = [];
    let prev = start;
    for (const n of path) {
      const names = (
        await runGit(
          [
            "diff",
            "--name-only",
            "--no-renames",
            prev.commitSha,
            n.commitSha,
            ...excludes(outputs),
          ],
          {
            gitDir: store.commonDir,
          },
        )
      ).stdout
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
      if (names.length)
        steps.push({
          nodeId: n.id,
          summary: n.summary ?? "",
          mode: "apply",
          paths: names,
          status: "pending",
        });
      prev = n;
    }
    if (recipe)
      steps.push({
        nodeId: "results",
        summary: `Regenerate the results with the recipe "${recipe.title}"`,
        mode: "recipe",
        paths: expandOutputs(recipe.outputs, recipe.params ?? {}),
        status: "pending",
      });
    else if (outputs.length)
      steps.push({
        nodeId: "results",
        summary: `Regenerate the results (${outputs.join(", ")}) as the original task did`,
        mode: "redo",
        paths: outputs,
        status: "pending",
      });
    return {
      source: { taskId, nodeId: end.id },
      steps,
      recipe,
      params: { ...(recipe?.params ?? {}) },
      outputs,
      startNodeId: start.id,
    };
  } finally {
    db.close();
  }
}

/**
 * A task that replays `taskId`'s path onto a base, next to the original. Its first run
 * applies and reruns without a model; see `pathReplayLauncher`.
 */
export async function createPathReplay(
  project: Project,
  o: {
    taskId: string;
    nodeId?: string;
    onto: "repo" | "start" | { taskId: string };
    params?: Record<string, string>;
    next?: string;
    title?: string;
    actor?: Actor;
  },
): Promise<Concept> {
  const plan = await planReplay(project, o.taskId, o.nodeId);
  const task = project.getConcept(o.taskId) as Concept;
  const params = { ...plan.params, ...(o.params ?? {}) };
  let startFrom: { taskId: string; checkpointId: string } | null = null;
  let onto: ReplaySpec["onto"] = "repo";
  if (o.onto === "start") {
    startFrom = { taskId: o.taskId, checkpointId: plan.startNodeId };
    onto = "start";
  } else if (typeof o.onto === "object") {
    const base = project.getConcept(o.onto.taskId);
    const cp = project.db
      .listLinks({ from: o.onto.taskId, rel: "evidence" })
      .filter((l) => l.to.type === "node")
      .at(-1);
    if (base?.kind !== "task" || !cp)
      throw new OpsError("that task has no checkpoint to replay onto");
    startFrom = { taskId: base.id, checkpointId: cp.to.id };
    onto = "checkpoint";
  }
  const changed = Object.entries(params)
    .filter(([k, v]) => plan.params[k] !== v)
    .map(([k, v]) => `${k}=${v}`);
  const where = onto === "repo" ? "on your repository" : onto === "start" ? "" : "on another base";
  const label = [changed.join(" "), where].filter(Boolean).join(", ") || "replay";
  return project.createConcept(
    {
      kind: "task",
      parentId: task.parentId,
      title: o.title?.trim() || `${task.title} (${label})`,
      body: `Replay of "${task.title}": ${plan.steps.length} step(s) redone ${where || "from the same start"}${changed.length ? ` with ${changed.join(" ")}` : ""}.`,
      assignee: { type: "agent" },
      ...(startFrom ? { startFrom } : {}),
      replay: {
        params,
        source: plan.source,
        onto,
        steps: plan.steps,
        ...(plan.recipe ? { recipeId: plan.recipe.id } : {}),
        ...(o.next?.trim() ? { next: o.next.trim() } : {}),
      },
    },
    o.actor ?? project.me,
  );
}

const fmtParams = (p: Record<string, string>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

/**
 * The first run of a path replay: no model. Each "apply" step's change (outputs excluded)
 * is applied to the workspace with `git apply` and checkpointed; then the recipe reruns the
 * results with the replay's parameters. The run stops at the first step that does not
 * apply or fails, and ends blocked with the remaining steps marked for an agent.
 */
export function pathReplayLauncher(
  project: Project,
  taskId: string,
  sandbox?: ScriptSandbox,
): RunnerLauncher {
  return fakeLauncher(
    async (a) => {
      const task = project.getConcept(taskId);
      const spec = task?.replay;
      const source = spec?.source ? project.getConcept(spec.source.taskId) : null;
      if (!task || !spec?.source || !source || !spec.steps) {
        await a.say("This task has nothing to replay.");
        await a.checkpoint("Nothing to replay", "blocked");
        await a.finish();
        return;
      }
      const actor: Actor = {
        type: "agent",
        id: a.spec.agentId,
        onBehalfOf: project.identity.memberId,
      };
      const steps: ReplayStep[] = spec.steps.map((s) => ({ ...s }));
      const save = async (result: ReplaySpec["result"]) =>
        project.updateConcept(taskId, { replay: { ...spec, steps, result } }, { actor });
      const recipe = spec.recipeId ? project.getConcept(spec.recipeId) : null;
      const outputs = outputsOf(project, source, recipe);
      await a.say(
        `Replaying ${steps.length} step(s) of "${source.title}"${spec.onto === "repo" ? " onto your repository as it is now" : ""}${Object.keys(spec.params).length ? ` with ${fmtParams(spec.params)}` : ""}. Code changes are applied as they were; results are rerun, never copied. No model is called unless a step fails.`,
      );
      const { store, db } = await openSource(project, source);
      const tmp = await mkdtemp(join(tmpdir(), "turtle-replay-"));
      try {
        const nodeOf = (id: string) => db.getNode(id);
        const start = db.getBranch(source.branches?.[0]?.branch ?? "")?.rootNodeId;
        let prevCommit = start ? nodeOf(start)?.commitSha : undefined;
        let stopped: { index: number; why: string } | null = null;
        for (const [i, step] of steps.entries()) {
          if (stopped) {
            step.status = "handed";
            if (step.mode === "apply")
              step.note = await patchText(store.commonDir, db, step, outputs);
            continue;
          }
          if (step.mode === "apply") {
            const node = nodeOf(step.nodeId);
            if (!node || !prevCommit) {
              stopped = { index: i, why: "the original checkpoint is missing" };
              step.status = "failed";
              continue;
            }
            const diff = (
              await runGit(
                [
                  "diff",
                  "--binary",
                  "--full-index",
                  "--no-renames",
                  prevCommit,
                  node.commitSha,
                  ...excludes(outputs),
                ],
                { gitDir: store.commonDir },
              )
            ).stdout;
            prevCommit = node.commitSha;
            const patchFile = join(tmp, `step-${i + 1}.patch`);
            await writeFile(patchFile, diff);
            const env = { GIT_CEILING_DIRECTORIES: dirname(a.workspace) };
            const check = await runGit(["apply", "--check", "--binary", patchFile], {
              cwd: a.workspace,
              env,
              okCodes: [0, 1, 128],
            });
            if (check.exitCode !== 0) {
              const why = check.stderr.trim().split("\n").slice(0, 6).join("\n");
              step.status = "failed";
              step.note = `${why}\n\n${diff.toString("utf8").slice(0, NOTE_MAX)}`;
              stopped = {
                index: i,
                why: `the change of step ${i + 1} no longer applies: ${firstLine(why)}`,
              };
              await a.tool(
                "Bash",
                { command: `git apply step-${i + 1}.patch`, description: firstLine(step.summary) },
                { response: why, failed: true },
              );
              continue;
            }
            await runGit(["apply", "--binary", patchFile], { cwd: a.workspace, env });
            step.status = "applied";
            await a.tool(
              "Bash",
              { command: `git apply step-${i + 1}.patch`, description: firstLine(step.summary) },
              { response: `applied: ${step.paths.join(", ")}` },
            );
            await a.checkpoint(`Replayed step ${i + 1}: ${firstLine(step.summary)}`, "progress");
          } else if (step.mode === "recipe" && recipe?.file && recipe.script) {
            for (const out of expandOutputs(recipe.outputs, spec.params))
              await rm(join(a.workspace, out), { recursive: true, force: true });
            const run = await runScript({
              file: recipe.file,
              script: recipe.script,
              cwd: a.workspace,
              env: { ...spec.params, TURTLE_RECIPE: recipe.id },
              timeoutMs: RECIPE_TIMEOUT_MS,
              ...(sandbox ? { sandbox } : {}),
            });
            await a.tool(
              "Bash",
              {
                command: `${INTERPRETER[extname(recipe.file)] ?? ""} ${recipe.file}`.trim(),
                description: `recipe with ${fmtParams(spec.params)}`,
              },
              { response: run.output, failed: !run.ok },
            );
            if (run.ok) step.status = "done";
            else {
              step.status = "failed";
              step.note = run.output.slice(-NOTE_MAX);
              stopped = {
                index: i,
                why: `the recipe failed: ${firstLine(run.output.split("\n").slice(-1)[0])}`,
              };
            }
          } else {
            // Results without a recipe: an agent regenerates them.
            step.status = "handed";
            stopped = { index: i, why: "the results have no recipe; an agent regenerates them" };
          }
        }
        const applied = steps.filter((s) => s.status === "applied" || s.status === "done").length;
        if (!stopped) {
          await save({
            ok: true,
            output: `${applied} step(s) replayed without a model`,
            at: new Date().toISOString(),
          });
          const cp = await a.checkpoint(
            `Replayed "${source.title}"${Object.keys(spec.params).length ? ` with ${fmtParams(spec.params)}` : ""}\n\n${steps.map((s, i) => `${i + 1}. ${firstLine(s.summary)} — ${s.status}`).join("\n")}`,
            "done",
          );
          await a.graph("brief", {
            text: `Status: ${/FAILED/.test(cp.message) ? "replayed, but a check fails" : "done"}. Replayed ${applied} step(s) of "${source.title}" without a model.`,
          });
          await a.finish("Replayed.");
        } else {
          await save({ ok: false, output: stopped.why, at: new Date().toISOString() });
          await a.checkpoint(
            `Replay stopped at step ${stopped.index + 1}: ${stopped.why}`,
            "blocked",
          );
          await a.graph("brief", {
            text: `Status: ${applied} step(s) replayed without a model; ${stopped.why}. An agent can do the rest.`,
          });
          await a.finish("An agent is needed for the rest.");
        }
      } finally {
        db.close();
        await rm(tmp, { recursive: true, force: true });
      }
    },
    { sessionless: true, free: true, model: "replay" },
  );
}

async function patchText(
  gitDir: string,
  db: TurtleDb,
  step: ReplayStep,
  outputs: string[],
): Promise<string> {
  const node = db.getNode(step.nodeId);
  const parent = node?.parents[0];
  if (!node || !parent) return "";
  // The change since the previous checkpoint on the branch (micro snapshots included).
  let prev = db.getNode(parent);
  while (prev && prev.kind === "micro" && prev.parents[0]) prev = db.getNode(prev.parents[0]);
  if (!prev) return "";
  const out = await runGit(
    ["diff", "--no-renames", prev.commitSha, node.commitSha, ...excludes(outputs)],
    {
      gitDir,
      okCodes: [0, 1],
    },
  );
  return out.stdout.toString("utf8").slice(0, NOTE_MAX);
}

/** The "## Replay" section of a path replay task's prompt, for the agent that takes over. */
export function pathReplayContext(project: Project, task: Concept): string | null {
  const spec = task.replay;
  if (!spec?.source || !spec.steps) return null;
  const source = project.getConcept(spec.source.taskId);
  const done = spec.steps.filter((s) => s.status === "applied" || s.status === "done");
  const left = spec.steps.filter((s) => s.status !== "applied" && s.status !== "done");
  const lines = [
    "## Replay",
    `This task redoes the steps of "${source?.title ?? "a task"}"${spec.onto === "repo" ? " on the repository as it is now" : ""}${Object.keys(spec.params).length ? `, with ${fmtParams(spec.params)} (environment variables for scripts)` : ""}. turtle applied what it could without a model: code changes as they were, results rerun by the recipe, never copied.`,
  ];
  if (done.length)
    lines.push(
      `Already done (keep them):\n${done.map((s) => `- ${firstLine(s.summary)}`).join("\n")}`,
    );
  if (left.length) {
    lines.push(
      `Left for you${spec.result && !spec.result.ok ? ` (${spec.result.output})` : ""}. Do these, in order, adapting them to the code as it is now:`,
    );
    for (const s of left)
      lines.push(
        `### ${firstLine(s.summary)}${s.mode === "redo" ? " (results: run what produces them; do not copy old files)" : ""}\nFiles: ${s.paths.join(", ") || "-"}${s.note ? `\n\`\`\`\n${s.note.slice(0, NOTE_MAX)}\n\`\`\`` : ""}`,
      );
    lines.push(
      "When it works, checkpoint it, and record a recipe with mcp__turtle__recipe for the results, so the next replay needs no agent.",
    );
  }
  if (spec.next) lines.push(`Then: ${spec.next}`);
  return lines.join("\n\n");
}
