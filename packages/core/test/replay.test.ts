import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { TurtleDb } from "../src/db/db.js";
import { GitStore } from "../src/git/store.js";
import { assembleTaskContext } from "../src/project/context.js";
import { Project } from "../src/project/project.js";
import { verifyRecipe } from "../src/project/recipes.js";
import {
  createChainReplay,
  createPathReplay,
  nextInstruction,
  planChain,
  planReplay,
} from "../src/project/replay.js";
import { startTaskRun } from "../src/project/task-run.js";
import type { Concept, ReplaySpec } from "../src/project/types.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeAgent, type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

const COMPILE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell script.
  'set -e\nmkdir -p build\nprintf "model=%s rate=%s\\n" "${MODEL:-A}" "${RATE:-1k}" > "build/model-${MODEL:-A}.bin"\n';

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "lab\n" });
  const store = await GitStore.open(repo);
  const project = await Project.ensureForRepo(store, { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  let launches = 0;
  const run = async (taskId: string, script?: FakeScript) => {
    let agent: FakeAgent | null = null;
    const r = await startTaskRun(project, taskId, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => {
        launches++;
        return fakeLauncher(
          script ??
            (async () => {
              throw new Error("no agent expected");
            }),
          {
            onAgent: (a) => {
              agent = a;
            },
          },
        );
      },
      workspaceRoot,
    });
    const out = await r.session.done;
    r.close();
    const t = project.getConcept(taskId);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    const ws = db.getBranch(t?.branches?.[0]?.branch ?? "")?.workspacePath ?? "";
    db.close();
    return { out, ws, agent: agent as FakeAgent | null };
  };
  const goal = await project.createConcept({ kind: "goal", parentId: null, title: "Phone" });
  const task = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: "Compile and measure",
    assignee: { type: "agent" },
  });
  // The original: two code steps, then results by a recipe.
  await run(task.id, async (a) => {
    await a.writeFile("build/compile.sh", COMPILE);
    await a.checkpoint("Add the compile script", "progress");
    await a.writeFile("notes.md", "how to compile\n");
    await a.checkpoint("Write notes", "progress");
    await a.writeFile("build/model-A.bin", "model=A rate=1k\n");
    await a.checkpoint("Compiled model A", "done");
    await a.graph("recipe", {
      title: "Compile",
      file: "c.sh",
      script: "bash build/compile.sh\n",
      params: { MODEL: "A", RATE: "1k" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a recipe output pattern.
      outputs: ["build/model-${MODEL}.bin"],
    });
    await a.finish();
  });
  const recipe = project.recipesOf(task.id)[0];
  if (!recipe) throw new Error("no recipe");
  expect((await verifyRecipe(project, recipe.id)).ok).toBe(true);
  return { project, repo, task, run, launches: () => launches };
}

describe("path replay (architecture §3.7)", () => {
  it("plans code steps to apply and results to rerun, never to copy", async () => {
    const { project, task } = await setup();
    const plan = await planReplay(project, task.id);
    expect(plan.steps.map((s) => `${s.mode}:${s.paths.join(",")}`)).toEqual([
      "apply:build/compile.sh",
      "apply:notes.md",
      "recipe:build/model-A.bin",
    ]);
    expect(plan.params).toEqual({ MODEL: "A", RATE: "1k" });
  });

  it("replays from the same start with other parameters, without a model", async () => {
    const { project, task, run, launches } = await setup();
    const r = await createPathReplay(project, {
      taskId: task.id,
      onto: "start",
      params: { RATE: "10k" },
    });
    expect(r.title).toBe("Compile and measure (RATE=10k)");
    const { out, ws } = await run(r.id);
    expect(out.reason).toBe("done");
    expect(launches()).toBe(1); // only the original's agent
    expect(await readFile(join(ws, "build/model-A.bin"), "utf8")).toBe("model=A rate=10k\n");
    expect(existsSync(join(ws, "notes.md"))).toBe(true);
    const spec = project.getConcept(r.id)?.replay;
    expect(spec?.steps?.map((s) => s.status)).toEqual(["applied", "applied", "done"]);
    // The rerun result is compared with the original's, and handed to the next agent.
    expect(spec?.comparison?.files).toEqual([
      { original: "build/model-A.bin", replay: "build/model-A.bin", status: "changed" },
    ]);
    expect(nextInstruction({ ...(spec as ReplaySpec), next: "Compare" })).toContain(
      "- build/model-A.bin: changed",
    );
  });

  it("replays onto the repository as it is now (the code changed)", async () => {
    const { project, repo, task, run } = await setup();
    await writeFile(join(repo, "README.md"), "lab, now with a new toolchain\n");
    await writeFile(join(repo, "toolchain.txt"), "v2\n");
    const r = await createPathReplay(project, {
      taskId: task.id,
      onto: "repo",
      params: { MODEL: "B" },
    });
    const { out, ws } = await run(r.id);
    expect(out.reason).toBe("done");
    expect(await readFile(join(ws, "toolchain.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(join(ws, "build/model-B.bin"), "utf8")).toBe("model=B rate=1k\n");
    // The old result was not copied.
    expect(existsSync(join(ws, "build/model-A.bin"))).toBe(false);
  });

  it("hands a step that no longer applies, and the rest, to an agent", async () => {
    const { project, repo, task, run, launches } = await setup();
    await writeFile(join(repo, "notes.md"), "notes already written differently\n");
    const r = await createPathReplay(project, {
      taskId: task.id,
      onto: "repo",
      next: "Then measure the power",
    });
    const first = await run(r.id);
    expect(first.out.reason).toBe("blocked");
    const spec = project.getConcept(r.id)?.replay;
    expect(spec?.result?.ok).toBe(false);
    expect(spec?.steps?.map((s) => s.status)).toEqual(["applied", "failed", "handed"]);
    const prompt = assembleTaskContext(project, r.id);
    expect(prompt).toContain("## Replay");
    expect(prompt).toContain("Already done (keep them):\n- Add the compile script");
    expect(prompt).toContain("### Write notes");
    expect(prompt).toContain("Then: Then measure the power");

    const second = await run(r.id, async (a) => {
      expect(a.prompt).toContain("Left for you");
      await a.writeFile("notes.md", "notes already written differently\nhow to compile\n");
      await a.tool("Bash", { command: "bash build/compile.sh" }, { response: "ok" });
      await a.checkpoint("Merged the notes and recompiled", "done");
      await a.finish();
    });
    expect(second.out.reason).toBe("done");
    expect(launches()).toBe(2);
    expect(project.getConcept(r.id)?.status).toBe("done");
  });

  it("hands results without a recipe to an agent", async () => {
    const { project, task, run } = await setup();
    for (const rc of project.recipesOf(task.id)) await project.dropConcept(rc.id);
    await project.createConcept({
      kind: "output",
      parentId: task.id,
      title: "build/model-A.bin",
      path: "build/model-A.bin",
    });
    const plan = await planReplay(project, task.id);
    expect(plan.steps.at(-1)).toMatchObject({ mode: "redo", paths: ["build/model-A.bin"] });
    const r = await createPathReplay(project, { taskId: task.id, onto: "start" });
    const { out } = await run(r.id);
    expect(out.reason).toBe("blocked");
    expect(project.getConcept(r.id)?.replay?.steps?.at(-1)?.status).toBe("handed");
  });
});

const FETCH =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell script.
  'set -e\nmkdir -p data\nprintf "prices from %s\\n" "${START:-2015}" > data/prices.csv\n';
const BACKTEST =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell script.
  'set -e\nmkdir -p out\nprintf "%s fee=%s\\n" "$(cat data/prices.csv)" "${FEE:-0.1}" > out/result.txt\n';

/** Two tasks: fetch data, then a backtest that started from the fetch's checkpoint. */
async function chainSetup() {
  const s = await setup();
  const { project, run } = s;
  const fetch = await project.createConcept({
    kind: "task",
    parentId: s.task.parentId,
    title: "Fetch prices",
    assignee: { type: "agent" },
  });
  await run(fetch.id, async (a) => {
    await a.writeFile("data/fetch.sh", FETCH);
    await a.checkpoint("Add the fetch script", "progress");
    await a.writeFile("data/prices.csv", "prices from 2015\n");
    await a.checkpoint("Fetched prices", "done");
    await a.graph("recipe", {
      title: "Fetch",
      file: "f.sh",
      script: "bash data/fetch.sh\n",
      params: { START: "2015" },
      outputs: ["data/prices.csv"],
    });
    await a.finish();
  });
  const fr = project.recipesOf(fetch.id)[0];
  if (!fr) throw new Error("no recipe");
  expect((await verifyRecipe(project, fr.id)).ok).toBe(true);
  const cp = project.db
    .listLinks({ from: fetch.id, rel: "evidence" })
    .filter((l) => l.to.type === "node")
    .at(-1)?.to.id as string;
  const backtest = await project.createConcept({
    kind: "task",
    parentId: s.task.parentId,
    title: "Backtest",
    assignee: { type: "agent" },
    dependsOn: [fetch.id],
    startFrom: { taskId: fetch.id, checkpointId: cp },
  });
  await run(backtest.id, async (a) => {
    await a.writeFile("backtest.sh", BACKTEST);
    await a.checkpoint("Add the backtest", "progress");
    await a.writeFile("out/result.txt", "prices from 2015 fee=0.1\n");
    await a.checkpoint("Backtested", "done");
    await a.graph("recipe", {
      title: "Backtest",
      file: "b.sh",
      script: "bash backtest.sh\n",
      params: { FEE: "0.1" },
      outputs: ["out/result.txt"],
    });
    await a.finish();
  });
  const br = project.recipesOf(backtest.id)[0];
  if (!br) throw new Error("no recipe");
  expect((await verifyRecipe(project, br.id)).ok).toBe(true);
  return { ...s, fetch, backtest };
}

describe("chain replay (architecture §3.7)", () => {
  it("plans a task with its upstream tasks, upstream first", async () => {
    const { project, fetch, backtest } = await chainSetup();
    const links = await planChain(project, backtest.id);
    expect(links.map((l) => l.title)).toEqual(["Fetch prices", "Backtest"]);
    expect(links[1]?.startsAfter).toBe(fetch.id);
    expect(links[0]?.plan?.params).toEqual({ START: "2015" });
    expect(links[1]?.plan?.steps.map((s) => s.mode)).toEqual(["apply", "recipe"]);
  });

  it("replays the chain without a model: downstream reruns on the new upstream results", async () => {
    const { project, backtest, fetch, run, launches } = await chainSetup();
    const made = await createChainReplay(project, {
      taskId: backtest.id,
      onto: "start",
      params: { [fetch.id]: { START: "2020" }, [backtest.id]: { FEE: "0.2" } },
    });
    expect(made).toHaveLength(2);
    const [f2, b2] = made as [Concept, Concept];
    expect(b2.dependsOn).toEqual([f2.id]);
    expect(b2.startFrom).toEqual({ taskId: f2.id, checkpointId: "latest" });
    expect(f2.replay?.chain).toBe(b2.replay?.chain);
    const before = launches();
    expect((await run(f2.id)).out.reason).toBe("done");
    const { out, ws } = await run(b2.id);
    expect(out.reason).toBe("done");
    expect(launches()).toBe(before);
    expect(await readFile(join(ws, "out/result.txt"), "utf8")).toBe("prices from 2020 fee=0.2\n");
  });

  it("keeps an excluded upstream task as it was", async () => {
    const { project, backtest, run } = await chainSetup();
    const made = await createChainReplay(project, {
      taskId: backtest.id,
      include: [backtest.id],
      onto: "repo",
      params: { [backtest.id]: { FEE: "0.3" } },
    });
    expect(made).toHaveLength(1);
    const b2 = made[0] as Concept;
    expect(b2.replay?.onto).toBe("start");
    const { out, ws } = await run(b2.id);
    expect(out.reason).toBe("done");
    expect(await readFile(join(ws, "out/result.txt"), "utf8")).toBe("prices from 2015 fee=0.3\n");
  });
});
