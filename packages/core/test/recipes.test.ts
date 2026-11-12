import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { GitStore } from "../src/git/store.js";
import { Project } from "../src/project/project.js";
import { compareOutput, expandOutputs, verifyRecipe } from "../src/project/recipes.js";
import { startTaskRun } from "../src/project/task-run.js";
import { runScript, scriptDockerArgs } from "../src/run/script.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeAgent, type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

const COMPILE_SH = `set -e
MODEL="\${MODEL:-A}"
mkdir -p build
case "$MODEL" in
  A) OPS="conv2d,relu" ;;
  *) echo "compile.sh: model $MODEL uses Conv3D, which this toolchain cannot lower" >&2; exit 2 ;;
esac
printf 'model=%s\\nops=%s\\n' "$MODEL" "$OPS" > "build/model-$MODEL.bin"
echo "compiled build/model-$MODEL.bin"
`;

// biome-ignore lint/suspicious/noTemplateCurlyInString: a recipe output pattern, expanded by turtle.
const OUT = "build/model-${MODEL}.bin";

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "phone lab\n" });
  const project = await Project.ensureForRepo(await GitStore.open(repo), { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  const agents: FakeAgent[] = [];
  let launched = 0;
  const run = async (taskId: string, script: FakeScript) => {
    const r = await startTaskRun(project, taskId, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => {
        launched++;
        return fakeLauncher(script, { onAgent: (a) => agents.push(a) });
      },
      workspaceRoot,
    });
    const out = await r.session.done;
    r.close();
    return { out, mode: r.mode };
  };
  const goal = await project.createConcept({ kind: "goal", parentId: null, title: "Phone" });
  const compile = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: "Compile model A",
    assignee: { type: "agent" },
  });
  return { project, run, goal, compile, agents, launches: () => launched };
}

describe("recipes (architecture §3.7, L2)", () => {
  it("compares outputs exactly, or CSV numbers within a tolerance", () => {
    const b = (s: string) => Buffer.from(s);
    expect(compareOutput("a.bin", b("x"), b("x"))).toBeNull();
    expect(compareOutput("a.bin", b("x"), null)).toMatch(/not produced/);
    expect(compareOutput("a.bin", null, b("x"))).toMatch(/not in the checkpoint/);
    const csv = "run,power_mw\n1,805.0\n2,798.0\n";
    expect(compareOutput("p.csv", b(csv), b("run,power_mw\n1,808.0\n2,795.5\n"), 0.03)).toBeNull();
    expect(compareOutput("p.csv", b(csv), b("run,power_mw\n1,900\n2,798.0\n"), 0.03)).toMatch(
      /1 value\(s\) differ beyond 3.0%: row 2 col 2: 805.0 vs 900/,
    );
    expect(compareOutput("p.csv", b(csv), b("run,power_mw\n1,805\n"), 0.03)).toMatch(/shape/);
    expect(compareOutput("p.csv", b(csv), b("run,power_mw\n1,808.0\n2,795.5\n"))).toMatch(
      /differs/,
    );
    expect(expandOutputs([OUT], { MODEL: "B" })).toEqual(["build/model-B.bin"]);
  });

  it("gives scripts the tolerance helpers, and runs them in docker with the workspace mounted", async () => {
    const dir = await tempDir("turtle-cwd-");
    const r = await runScript({
      file: "check.py",
      script:
        "from turtle_check import *\nexpect_within(102, 100, rel=0.01, what='power')\ndone()\n",
      cwd: dir,
      timeoutMs: 30_000,
    });
    expect(r).toMatchObject({ ok: false, output: "power: 102 is not within 1.0% of 100" });
    const args = scriptDockerArgs(
      { image: "lab/phone:1" },
      {
        cwd: "/ws",
        scriptDir: "/tmp/s",
        interpreter: "python3",
        file: "c.py",
        env: { MODEL: "B" },
      },
      { uid: 501, gid: 20 },
    );
    expect(args.join(" ")).toBe(
      "run --rm --user 501:20 -v /ws:/workspace -v /tmp/s:/turtle-script:ro -w /workspace -e HOME=/tmp/home -e PYTHONPATH=/turtle-script -e MODEL=B lab/phone:1 python3 /turtle-script/c.py",
    );
  });

  it("verifies a recipe by replaying it from a clean copy of the checkpoint", async () => {
    const { project, run, compile } = await setup();
    let recipeId = "";
    await run(compile.id, async (a) => {
      await a.writeFile("build/compile.sh", COMPILE_SH);
      await a.writeFile("build/model-A.bin", "model=A\nops=conv2d,relu\n");
      await a.checkpoint("Compiled model A", "done");
      const r = await a.graph("recipe", {
        title: "Compile a model",
        file: "compile.sh",
        script: "bash build/compile.sh\n",
        params: { MODEL: "A" },
        outputs: [OUT],
      });
      recipeId = r.id ?? "";
      await a.finish();
    });
    expect(project.getConcept(recipeId)).toMatchObject({ kind: "recipe", recipeState: "draft" });
    const v = await verifyRecipe(project, recipeId);
    expect(v).toMatchObject({ ok: true, problems: [] });
    expect(project.getConcept(recipeId)?.recipeState).toBe("verified");

    // A recipe that does not regenerate the same output fails verification.
    const bad = await project.addRecipe({
      taskId: compile.id,
      title: "Wrong",
      file: "wrong.sh",
      script: "mkdir -p build && echo other > build/model-A.bin\n",
      outputs: ["build/model-A.bin"],
    });
    const v2 = await verifyRecipe(project, bad.id);
    expect(v2.ok).toBe(false);
    expect(v2.problems[0]).toMatch(/build\/model-A.bin: differs from the checkpoint/);
    await expect(project.replayRecipe(bad.id, {})).rejects.toThrow(/verified/);
  });

  it("replays with other parameters without a model; an agent repairs only what fails", async () => {
    const { project, run, compile, agents, launches } = await setup();
    let recipeId = "";
    await run(compile.id, async (a) => {
      await a.writeFile("build/compile.sh", COMPILE_SH);
      await a.writeFile("build/model-A.bin", "model=A\nops=conv2d,relu\n");
      await a.checkpoint("Compiled model A", "done");
      recipeId =
        (
          await a.graph("recipe", {
            title: "Compile a model",
            file: "compile.sh",
            script: "bash build/compile.sh\n",
            params: { MODEL: "A" },
            outputs: [OUT],
          })
        ).id ?? "";
      await a.finish();
    });
    await verifyRecipe(project, recipeId);
    expect(launches()).toBe(1);

    // Same parameters: the recipe alone redoes the step.
    const same = await project.replayRecipe(recipeId, {});
    const r0 = await run(same.id, async () => {
      throw new Error("no agent should run");
    });
    expect(r0.out.reason).toBe("done");
    expect(launches()).toBe(1);
    expect(project.getConcept(same.id)).toMatchObject({ status: "done" });

    // Model B: the recipe fails, so the task is blocked with the output…
    const b = await project.replayRecipe(recipeId, { MODEL: "B" });
    expect(b).toMatchObject({
      title: "Compile model A (MODEL=B)",
      startFrom: { taskId: compile.id },
    });
    const r1 = await run(b.id, async () => {
      throw new Error("no agent should run");
    });
    expect(r1.mode).toBe("fork");
    expect(launches()).toBe(1);
    const blocked = project.getConcept(b.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.replay?.result).toMatchObject({ ok: false });
    expect(blocked?.replay?.result?.output).toMatch(/cannot lower/);

    // …and an agent takes over with the full task prompt and the failure.
    let newRecipe = "";
    const r2 = await run(b.id, async (a) => {
      expect(a.prompt).toContain("## Replay");
      expect(a.prompt).toContain("It FAILED");
      expect(a.prompt).toContain("cannot lower");
      expect(a.options.resume).toBeUndefined();
      await a.edit(
        "build/compile.sh",
        COMPILE_SH.replace(
          'A) OPS="conv2d,relu" ;;',
          'A) OPS="conv2d,relu" ;;\n  B) OPS="conv3d,relu" ;;',
        ),
      );
      await a.writeFile("build/model-B.bin", "model=B\nops=conv3d,relu\n");
      await a.checkpoint("Compiled model B with Conv3D lowering", "done");
      newRecipe =
        (
          await a.graph("recipe", {
            title: "Compile a model",
            file: "compile.sh",
            script: "bash build/compile.sh\n",
            params: { MODEL: "B" },
            outputs: [OUT],
          })
        ).id ?? "";
      await a.finish();
    });
    expect(r2.mode).toBe("continue");
    expect(launches()).toBe(2);
    expect(agents).toHaveLength(2);
    expect(project.getConcept(b.id)?.status).toBe("done");
    expect((await verifyRecipe(project, newRecipe)).ok).toBe(true);
  });
});
