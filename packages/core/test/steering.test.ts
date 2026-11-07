import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { GitStore } from "../src/git/store.js";
import { Project } from "../src/project/project.js";
import { startTaskRun, stopTask, tellTask } from "../src/project/task-run.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeAgent, type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "x\n" });
  const project = await Project.ensureForRepo(await GitStore.open(repo), { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  const goal = await project.createConcept({ kind: "goal", parentId: null, title: "G" });
  const task = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: "T",
    assignee: { type: "agent" },
  });
  const start = async (script: FakeScript) => {
    let agent: FakeAgent | undefined;
    const r = await startTaskRun(project, task.id, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => fakeLauncher(script, { onAgent: (a) => (agent = a) }),
      workspaceRoot,
    });
    return { ...r, agent: () => agent as FakeAgent };
  };
  return { project, task, start };
}

describe("steering a running task", () => {
  it("delivers an instruction at the next tool boundary", async () => {
    const { project, task, start } = await setup();
    const working = gate();
    const told = gate();
    const r = await start(async (a) => {
      await a.edit("a.txt", "a\n");
      working.open();
      await told.p;
      await a.tool("Read", { file_path: "a.txt" }); // the instruction arrives in this reply
      if (a.instructions.length) await a.edit("done.txt", "as you asked\n");
      await a.finish();
    });
    await working.p;
    await tellTask(project, task.id, "Also write done.txt");
    told.open();
    await r.session.done;
    r.close();
    expect(r.agent().instructions).toEqual(["Also write done.txt"]);
    const delivered = r.session; // events recorded on the source DB
    expect(delivered.mode).toBe("new");
    expect(project.getConcept(task.id)?.status).toBe("done");
  });

  it("keeps the conversation going when an instruction arrives as the agent finishes", async () => {
    const { project, task, start } = await setup();
    const working = gate();
    const told = gate();
    let rounds = 0;
    const r = await start(async (a) => {
      await a.edit("a.txt", "a\n");
      working.open();
      await told.p;
      let ins = await a.finish("Done.");
      while (ins) {
        rounds++;
        await a.edit("b.txt", "b\n");
        ins = await a.finish("Done, with b.txt too.");
      }
    });
    await working.p;
    await tellTask(project, task.id, "Add b.txt before you stop");
    told.open();
    const out = await r.session.done;
    r.close();
    expect(rounds).toBe(1);
    expect(out.reason).toBe("done");
    expect(r.agent().instructions[0]).toContain("Add b.txt before you stop");
  });

  it("pauses and drops through stop requests that any process can make", async () => {
    const { project, task, start } = await setup();
    const working = gate();
    const r = await start(async (a) => {
      await a.edit("a.txt", "a\n");
      working.open();
      for (;;) await a.tool("Read", { file_path: "a.txt" }); // keeps working until stopped
    });
    await working.p;
    expect((await stopTask(project, task.id)).stopped).toBe(true);
    const out = await r.session.done;
    r.close();
    expect(out.reason).toBe("killed");
    expect(project.getConcept(task.id)?.status).toBe("paused");
    await expect(tellTask(project, task.id, "x")).rejects.toThrow(/no running agent/);

    // Resume = continue the branch; then drop it while it runs.
    const again = gate();
    const r2 = await start(async (a) => {
      again.open();
      for (;;) await a.tool("Read", { file_path: "a.txt" });
    });
    expect(r2.mode).toBe("continue");
    await again.p;
    await stopTask(project, task.id, { drop: true });
    await r2.session.done;
    r2.close();
    expect(project.getConcept(task.id)?.status).toBe("dropped");
  });
});
