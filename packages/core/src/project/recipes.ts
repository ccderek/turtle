import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { TurtleDb } from "../db/db.js";
import { GitStore } from "../git/store.js";
import { OpsError } from "../ops.js";
import { INTERPRETER, runScript, type ScriptSandbox } from "../run/script.js";
import type { RunnerLauncher } from "../run/transport.js";
import { fakeLauncher } from "../testing/fake-runner.js";
import { runCheck } from "./checks.js";
import type { Project } from "./project.js";
import type { Actor, Concept, RecipeVerification } from "./types.js";

export const RECIPE_TIMEOUT_MS = 30 * 60_000;

/** Output paths with `${PARAM}` replaced by the parameters' values. */
export function expandOutputs(outputs: string[] | undefined, params: Record<string, string>) {
  return (outputs ?? []).map((o) =>
    o.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => params[k] ?? ""),
  );
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 10);

/**
 * Compare a regenerated output with the version in the checkpoint. Equal bytes match.
 * With a tolerance, a CSV or TSV matches when it has the same shape, equal text cells
 * and numbers within `tolerance` (relative). Returns the problem, or null.
 */
export function compareOutput(
  path: string,
  expected: Buffer | null,
  actual: Buffer | null,
  tolerance = 0,
): string | null {
  if (!actual) return `${path}: not produced`;
  if (!expected) return `${path}: not in the checkpoint, so there is nothing to compare with`;
  if (expected.equals(actual)) return null;
  const ext = extname(path).toLowerCase();
  if (tolerance > 0 && (ext === ".csv" || ext === ".tsv")) {
    const sep = ext === ".tsv" ? "\t" : ",";
    const table = (b: Buffer) =>
      b
        .toString("utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => l.split(sep).map((c) => c.trim()));
    const a = table(expected);
    const b = table(actual);
    if (a.length !== b.length || a.some((row, i) => row.length !== b[i]?.length))
      return `${path}: the table has a different shape (${a.length} vs ${b.length} rows)`;
    const bad: string[] = [];
    for (const [i, row] of a.entries()) {
      for (const [j, x] of row.entries()) {
        const y = b[i]?.[j] ?? "";
        const nx = Number(x);
        const ny = Number(y);
        if (x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny)) {
          const allowed = tolerance * Math.max(Math.abs(nx), Math.abs(ny)) + 1e-12;
          if (Math.abs(nx - ny) > allowed) bad.push(`row ${i + 1} col ${j + 1}: ${x} vs ${y}`);
        } else if (x !== y) bad.push(`row ${i + 1} col ${j + 1}: "${x}" vs "${y}"`);
      }
    }
    if (!bad.length) return null;
    return `${path}: ${bad.length} value(s) differ beyond ${(tolerance * 100).toFixed(1)}%: ${bad.slice(0, 3).join("; ")}`;
  }
  return `${path}: differs from the checkpoint (sha256 ${sha(expected)} vs ${sha(actual)})${tolerance > 0 ? "; tolerances apply to .csv and .tsv only" : ""}`;
}

function lastLines(s: string, n = 3): string {
  return s.trim().split("\n").slice(-n).join(" / ");
}

/** Recipes run on single-source projects for now (multi-source checkpoints are a set). */
function requireSingleSource(project: Project): void {
  if (project.config.sources.length > 1)
    throw new OpsError("recipes are not supported yet in projects with several sources");
}

/** The source store and database holding a task's checkpoint. */
async function sourceOf(project: Project, task: Concept, nodeId: string) {
  for (const b of task.branches ?? []) {
    const src = project.config.sources.find((s) => s.id === b.source);
    if (!src) continue;
    const store = await GitStore.open(src.path);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    const node = db.getNode(nodeId);
    if (node) return { store, db, node };
    db.close();
  }
  throw new OpsError("the task's checkpoint is not in any of its sources");
}

/**
 * Verify a recipe by a clean replay (architecture §3.7): materialize the task's latest
 * checkpoint in a fresh directory, delete the recipe's outputs, run the recipe with its
 * default parameters, then compare each output with the checkpoint's version and run the
 * checks in scope. The result is recorded on the recipe (`verified` or `failed`).
 */
export async function verifyRecipe(
  project: Project,
  recipeId: string,
  o: { sandbox?: ScriptSandbox; timeoutMs?: number; actor?: Actor } = {},
): Promise<RecipeVerification> {
  const recipe = project.getConcept(recipeId);
  if (recipe?.kind !== "recipe" || !recipe.file || !recipe.script)
    throw new OpsError(`${recipeId} is not a recipe`);
  const task = project.getConcept(recipe.parentId ?? "");
  if (task?.kind !== "task") throw new OpsError("the recipe has no task");
  requireSingleSource(project);
  const cp = project.db
    .listLinks({ from: task.id, rel: "evidence" })
    .filter((l) => l.to.type === "node")
    .at(-1);
  if (!cp) throw new OpsError("the task has no checkpoint to verify the recipe against");
  const { store, db, node } = await sourceOf(project, task, cp.to.id);
  const actor = o.actor ? { actor: o.actor } : {};
  await project.updateConcept(recipeId, { recipeState: "verifying" }, actor);
  const dir = await mkdtemp(join(tmpdir(), "turtle-replay-"));
  const started = Date.now();
  let v: RecipeVerification;
  try {
    const ws = join(dir, "ws");
    await store.materialize(node.commitSha, ws, join(dir, "index"));
    const params = recipe.params ?? {};
    const outs = expandOutputs(recipe.outputs, params);
    const expected = new Map<string, Buffer | null>();
    for (const out of outs) {
      expected.set(out, await store.readBlob(`${node.commitSha}:${out}`).catch(() => null));
      await rm(join(ws, out), { recursive: true, force: true });
    }
    const run = await runScript({
      file: recipe.file,
      script: recipe.script,
      cwd: ws,
      env: { ...params, TURTLE_RECIPE: recipe.id },
      timeoutMs: o.timeoutMs ?? RECIPE_TIMEOUT_MS,
      ...(o.sandbox ? { sandbox: o.sandbox } : {}),
    });
    const problems: string[] = [];
    if (!run.ok) problems.push(`the recipe failed: ${lastLines(run.output)}`);
    else {
      for (const out of outs) {
        const actual = await readFile(join(ws, out)).catch(() => null);
        const p = compareOutput(out, expected.get(out) ?? null, actual, recipe.tolerance ?? 0);
        if (p) problems.push(p);
      }
      for (const check of project.checksInScope(task.id)) {
        const r = await runCheck(check, ws, o.sandbox ? { sandbox: o.sandbox } : {});
        if (!r.ok) problems.push(`check "${check.title}" fails: ${lastLines(r.output)}`);
      }
    }
    v = {
      ok: problems.length === 0,
      at: new Date().toISOString(),
      checkpointId: node.id,
      output: run.output,
      problems,
      ms: Date.now() - started,
    };
  } catch (err) {
    v = {
      ok: false,
      at: new Date().toISOString(),
      checkpointId: node.id,
      output: "",
      problems: [(err as Error).message],
      ms: Date.now() - started,
    };
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
  await project.updateConcept(
    recipeId,
    { recipeState: v.ok ? "verified" : "failed", verification: v },
    actor,
  );
  return v;
}

const fmtParams = (p: Record<string, string>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "its default parameters";

/**
 * The runner of a replay task's first run: no model. It deletes the recipe's outputs,
 * runs the recipe in the workspace (forked from the verified checkpoint) with the
 * replay's parameters, and checkpoints the result: done, or blocked with the output, so
 * an agent can take over only for what failed.
 */
export function recipeLauncher(
  project: Project,
  taskId: string,
  sandbox?: ScriptSandbox,
): RunnerLauncher {
  return fakeLauncher(
    async (a) => {
      const task = project.getConcept(taskId);
      const spec = task?.replay;
      const recipe = spec ? project.getConcept(spec.recipeId) : null;
      if (!task || !spec || recipe?.kind !== "recipe" || !recipe.file || !recipe.script) {
        await a.say("This task has no recipe to replay.");
        await a.checkpoint("No recipe to replay", "blocked");
        await a.finish("No recipe to replay.");
        return;
      }
      const actor: Actor = {
        type: "agent",
        id: a.spec.agentId,
        onBehalfOf: project.identity.memberId,
      };
      const params = spec.params;
      await a.say(
        `Replaying the recipe "${recipe.title}" (${recipe.file}) with ${fmtParams(params)}. No model is called; an agent takes over only if it fails.`,
      );
      for (const out of expandOutputs(recipe.outputs, params))
        await rm(join(a.workspace, out), { recursive: true, force: true });
      const run = await runScript({
        file: recipe.file,
        script: recipe.script,
        cwd: a.workspace,
        env: { ...params, TURTLE_RECIPE: recipe.id },
        timeoutMs: RECIPE_TIMEOUT_MS,
        ...(sandbox ? { sandbox } : {}),
      });
      await a.tool(
        "Bash",
        {
          command: `${INTERPRETER[extname(recipe.file)] ?? ""} ${recipe.file}`.trim(),
          description: `recipe "${recipe.title}" with ${fmtParams(params)}`,
        },
        { response: run.output, failed: !run.ok },
      );
      await project.updateConcept(
        taskId,
        {
          replay: {
            ...spec,
            result: { ok: run.ok, output: run.output, at: new Date().toISOString() },
          },
        },
        { actor },
      );
      if (run.ok) {
        const cp = await a.checkpoint(
          `Replayed "${recipe.title}" with ${fmtParams(params)}\n\n${lastLines(run.output, 6)}`,
          "done",
        );
        await a.graph("brief", {
          text: `Status: ${/FAILED/.test(cp.message) ? "the recipe ran, but a check fails" : "done"}. Replayed "${recipe.title}" with ${fmtParams(params)}; no model was called.`,
        });
        await a.finish("Replayed.");
      } else {
        await a.checkpoint(
          `Replay failed: "${recipe.title}" with ${fmtParams(params)}\n\n${lastLines(run.output, 6)}`,
          "blocked",
        );
        await a.graph("brief", {
          text: `Status: the recipe failed with ${fmtParams(params)}: ${lastLines(run.output)}. An agent can fix only what fails.`,
        });
        await a.finish("The recipe failed.");
      }
    },
    { sessionless: true, free: true, model: "recipe" },
  );
}

/** The "## Replay" section of a replay task's prompt, for an agent repairing it. */
export function replayContext(project: Project, task: Concept): string | null {
  const spec = task.replay;
  if (!spec) return null;
  const recipe = project.getConcept(spec.recipeId);
  if (!recipe) return null;
  const from = project.getConcept(recipe.parentId ?? "");
  const lines = [
    `## Replay`,
    `This task redoes "${from?.title ?? "a task"}" with ${fmtParams(spec.params)}. Your working directory is that task's verified checkpoint. turtle first ran its recipe (\`${recipe.file}\`, below) with these parameters as environment variables.`,
  ];
  if (spec.result && !spec.result.ok)
    lines.push(
      `It FAILED. Its output:\n\`\`\`\n${spec.result.output.slice(-2000)}\n\`\`\`\nFix only what fails for these parameters; keep everything else as it is. When it works, record the updated recipe with mcp__turtle__recipe (same outputs, parameters ${fmtParams(spec.params)}), so the next replay needs no agent.`,
    );
  lines.push(`\`\`\`\n${recipe.script?.slice(0, 3000) ?? ""}\n\`\`\``);
  return lines.join("\n\n");
}

export { requireSingleSource };
