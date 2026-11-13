import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { GitStore } from "../src/git/store.js";
import { runCheck } from "../src/project/checks.js";
import { assembleTaskContext } from "../src/project/context.js";
import { Project } from "../src/project/project.js";
import { startTaskRun } from "../src/project/task-run.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeAgent, type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

// Every metric,value results CSV must report an out-of-sample score (the lesson, hardened).
const OOS_CHECK = `import { readFileSync, readdirSync, existsSync } from "node:fs";
const bad = [];
for (const f of existsSync("results") ? readdirSync("results") : []) {
  const rows = readFileSync("results/" + f, "utf8").trim().split("\\n");
  if (rows[0] === "metric,value" && !rows.some((r) => r.startsWith("out_of_sample,")))
    bad.push("results/" + f);
}
if (bad.length) {
  console.log("No out-of-sample score in: " + bad.join(", "));
  process.exit(1);
}
console.log("Every result reports an out-of-sample score.");
`;

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "trader\n" });
  const project = await Project.ensureForRepo(await GitStore.open(repo), { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  const agents: FakeAgent[] = [];
  const run = async (taskId: string, script: FakeScript) => {
    const r = await startTaskRun(project, taskId, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => fakeLauncher(script, { onAgent: (a) => agents.push(a) }),
      workspaceRoot,
    });
    const out = await r.session.done;
    r.close();
    return { out, agent: agents.at(-1) as FakeAgent };
  };
  const goal = await project.createConcept({ kind: "goal", parentId: null, title: "Trade" });
  const signal = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: "Investment signal",
    assignee: { type: "agent" },
  });
  const lesson = await project.createConcept({
    kind: "lesson",
    parentId: signal.id,
    title: "Always keep 6 months out of sample",
    lessonState: "confirmed",
  });
  return { project, run, goal, signal, lesson };
}

describe("checks (hardened lessons, architecture §3.7)", () => {
  it("runs a script outside the workspace: exit 0 passes, output explains", async () => {
    const { project, signal } = await setup();
    const c = await project.addCheck({
      on: signal.id,
      title: "Has a README",
      file: "readme.sh",
      script: 'test -f README.md && echo found || { echo "README.md is missing"; exit 3; }\n',
    });
    const dir = await tempDir("turtle-cwd-");
    const miss = await runCheck(c, dir);
    expect(miss).toMatchObject({ ok: false, output: "README.md is missing" });
    // The script is not left in the working directory.
    expect(existsSync(`${dir}/readme.sh`)).toBe(false);
    await expect(
      project.addCheck({ on: signal.id, title: "x", file: "../evil.py", script: "x" }),
    ).rejects.toThrow(/file name/);
  });

  it("enforces a lesson's check at every checkpoint: the agent is told, fixes it, ends done", async () => {
    const { project, run, signal, lesson } = await setup();
    const check = await project.addCheck({
      on: lesson.id,
      title: "Results report an out-of-sample score",
      file: "check_oos.mjs",
      script: OOS_CHECK,
    });
    expect(check).toMatchObject({ parentId: signal.id, checkState: "active" });
    expect(project.db.listLinks({ from: check.id, rel: "enforces" })[0]?.to.id).toBe(lesson.id);

    const approach = await project.createConcept({
      kind: "task",
      parentId: signal.id,
      title: "Approach B: momentum",
      assignee: { type: "agent" },
    });
    expect(assembleTaskContext(project, approach.id)).toContain("## Checks that must pass");

    const replies: string[] = [];
    const r = await run(approach.id, async (a) => {
      await a.writeFile("results/b.csv", "metric,value\nsharpe,1.4\n");
      replies.push((await a.checkpoint("Momentum backtest", "done")).message);
      await a.writeFile("results/b.csv", "metric,value\nsharpe,1.4\nout_of_sample,0.9\n");
      replies.push((await a.checkpoint("Added the out-of-sample score", "done")).message);
      await a.finish();
    });
    expect(r.out.reason).toBe("done");
    expect(replies[0]).toMatch(/1 of 1 check\(s\) FAILED/);
    expect(replies[0]).toContain("No out-of-sample score in: results/b.csv");
    expect(replies[1]).toMatch(/All 1 check\(s\) in scope pass/);
    const t = project.getConcept(approach.id);
    expect(t?.status).toBe("done");
    expect(t?.checkResults?.[check.id]).toMatchObject({ ok: true });
  });

  it("blocks done while a check fails, and only runs checks a member activated", async () => {
    const { project, run, signal, lesson } = await setup();
    await project.addCheck({
      on: lesson.id,
      title: "Results report an out-of-sample score",
      file: "check_oos.mjs",
      script: OOS_CHECK,
    });
    const a = await project.createConcept({
      kind: "task",
      parentId: signal.id,
      title: "Approach A: sentiment",
      assignee: { type: "agent" },
    });
    let proposed = "";
    await run(a.id, async (ag) => {
      await ag.writeFile("results/a.csv", "metric,value\nsharpe,2.1\n");
      const p = await ag.graph("check", {
        title: "Sharpe is below 5 (sanity)",
        file: "sane.py",
        script: "raise SystemExit(1)\n",
        lesson: lesson.id,
      });
      proposed = p.id ?? "";
      await ag.checkpoint("In-sample backtest", "done");
      await ag.finish();
    });
    const t = project.getConcept(a.id);
    expect(t?.status).toBe("blocked");
    // The proposed check did not run: an agent's script runs only once a member activates it.
    expect(project.getConcept(proposed)).toMatchObject({ checkState: "proposed" });
    expect(Object.keys(t?.checkResults ?? {})).toHaveLength(1);
    expect(project.checksInScope(a.id)).toHaveLength(1);
  });

  it("applies the project's defaults to task runs (model, budget)", async () => {
    const { project, run, signal } = await setup();
    project.config.defaults.maxBudgetUsd = 0.5;
    await project.setDefaults({ model: "claude-haiku-5-5", effort: "low" });
    await expect(project.setDefaults({ effort: "huge" as "low" })).rejects.toThrow(
      /effort is one of/,
    );
    let options: Record<string, unknown> = {};
    await run(signal.id, async (a) => {
      options = a.options as unknown as Record<string, unknown>;
      await a.finish();
    });
    expect(options).toMatchObject({ maxBudgetUsd: 0.5, model: "claude-haiku-5-5", effort: "low" });
    // null removes a default; the file is committed in the project repository.
    await project.setDefaults({ effort: null });
    expect(project.config.defaults.effort).toBeUndefined();
    expect(project.config.defaults.model).toBe("claude-haiku-5-5");
  });
});
