import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { GitStore } from "../src/git/store.js";
import { assembleTaskContext } from "../src/project/context.js";
import { Project } from "../src/project/project.js";
import { startTaskRun } from "../src/project/task-run.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeAgent, type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "trader\n" });
  const project = await Project.ensureForRepo(await GitStore.open(repo), { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  const agents: FakeAgent[] = [];
  const run = async (taskId: string, script: FakeScript, instruction?: string) => {
    const r = await startTaskRun(
      project,
      taskId,
      {
        config,
        summarizer: new HeuristicSummarizer(),
        launcherFor: () => fakeLauncher(script, { onAgent: (a) => agents.push(a) }),
        workspaceRoot,
      },
      instruction ? { instruction } : {},
    );
    const out = await r.session.done;
    r.close();
    return { ...r, out, agent: agents.at(-1) as FakeAgent };
  };
  const goal = await project.createConcept({
    kind: "goal",
    parentId: null,
    title: "Build a trading system",
  });
  return { project, run, goal };
}

describe("task runs and the graph tools", () => {
  it("records findings with evidence, decisions, briefs and subtasks; keeps status and branches", async () => {
    const { project, run, goal } = await setup();
    const signal = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Investment signal",
      body: "Decide when to buy and sell.",
      assignee: { type: "agent" },
    });
    const r = await run(signal.id, async (a) => {
      const g = await a.graph("read");
      expect(g.message).toContain("Your task: Investment signal");
      await a.writeFile("framework.py", "def signal(): ...\n");
      await a.edit("framework.py", "def signal(): return 0\n");
      await a.writeFile("results/corr.csv", "lag,corr\n1,0.31\n");
      const f = await a.graph("finding", {
        text: "Sentiment correlates 0.31 with next-day return",
        evidence: [{ path: "results/corr.csv" }],
      });
      expect(f.message).toMatch(/1 piece/);
      const bare = await a.graph("finding", { text: "Looks promising" });
      expect(bare.message).toMatch(/claimed/);
      await a.graph("decision", { text: "Use daily bars", rationale: "8-hour cadence" });
      const cp = await a.checkpoint("Signal framework r1", "progress");
      expect(cp.message).toMatch(/no brief yet/);
      const t = await a.graph("task", {
        op: "create",
        title: "Approach A: news sentiment",
        startFrom: "here",
      });
      expect(t.message).toMatch(/created/);
      await a.graph("brief", { text: "Framework done; approach A queued." });
      await a.finish();
    });
    expect(r.out.reason).toBe("done");
    expect(r.agent.prompt).toContain("# Your task: Investment signal");
    expect(r.agent.prompt).toContain("Build a trading system");

    const t = project.getConcept(signal.id);
    expect(t).toMatchObject({ status: "done", brief: "Framework done; approach A queued." });
    expect(t?.branches?.[0]?.source).toBe(project.config.sources[0]?.id);
    const kids = project.db.listConcepts({ parentId: signal.id });
    expect(kids.map((k) => k.kind).sort()).toEqual([
      "decision",
      "finding",
      "finding",
      "output",
      "task",
    ]);
    const output = kids.find((k) => k.kind === "output");
    expect(output).toMatchObject({ path: "results/corr.csv", size: 16 });
    expect(output?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sub = kids.find((k) => k.kind === "task");
    expect(sub?.startFrom?.taskId).toBe(signal.id);
    expect(project.db.listLinks({ from: signal.id, rel: "evidence" }).length).toBeGreaterThan(0);
    // Agent edits are attributed to the agent, on behalf of the member.
    expect(sub?.createdBy).toMatchObject({ type: "agent", onBehalfOf: project.identity.memberId });
  });

  it("abandons an approach into a lesson and retries from the checkpoint before it", async () => {
    const { project, run, goal } = await setup();
    const signal = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Investment signal",
      assignee: { type: "agent" },
    });
    let aId = "";
    await run(signal.id, async (a) => {
      await a.edit("framework.py", "r1\n");
      await a.checkpoint("Framework r1", "progress");
      aId = (
        await a.graph("task", {
          op: "create",
          title: "Approach A: news sentiment",
          startFrom: "here",
        })
      ).id as string;
      await a.finish();
    });

    // Approach A forks from r1, works, and fails out of sample.
    const a = await run(aId, async (ag) => {
      await ag.edit("sentiment.py", "uses close-of-day news\n");
      await ag.graph("finding", { text: "In-sample Sharpe 2.1" });
      await ag.graph("finding", {
        text: "Out-of-sample Sharpe -0.3: features used news published after the close (look-ahead)",
      });
      await ag.checkpoint("Approach A evaluated", "blocked");
      await ag.finish();
    });
    expect(a.mode).toBe("fork");
    expect(project.getConcept(aId)?.status).toBe("blocked");

    const { task, lesson } = await project.abandonTask(aId);
    expect(task.status).toBe("abandoned");
    expect(lesson).toMatchObject({ kind: "lesson", parentId: signal.id, lessonState: "proposed" });
    expect(lesson.body).toContain("look-ahead");
    // The human edits and confirms the lesson.
    await project.updateConcept(lesson.id, {
      body: "Only use data known before the close of t-1; always keep 6 months out of sample.",
      lessonState: "confirmed",
    });

    const b = await project.retryTask(signal.id, "Approach B: price momentum");
    const r1 = project.db.listLinks({ from: signal.id, rel: "evidence" })[0]?.to.id;
    expect(b.startFrom).toEqual({ taskId: signal.id, checkpointId: r1 });
    expect(assembleTaskContext(project, b.id)).toContain("## Lessons you must follow");

    let sawA = true;
    const rb = await run(b.id, async (ag) => {
      sawA = existsSync(join(ag.workspace, "sentiment.py"));
      const g = await ag.graph("read");
      expect(g.message).toContain("Only use data known before the close of t-1");
      expect(g.message).toContain('abandoned "Approach A: news sentiment"');
      await ag.graph("question", {
        text: "Momentum window: 20 or 60 days?",
        options: ["20", "60"],
      });
      await ag.finish("20 or 60?");
    });
    expect(rb.mode).toBe("fork");
    expect(sawA).toBe(false); // the retry starts from r1, before A's work
    expect(rb.agent.prompt).toContain("Only use data known before the close of t-1");
    expect(rb.agent.prompt).not.toContain("sentiment.py");
    expect(project.getConcept(b.id)?.status).toBe("need_decision");

    // Answering continues the same branch with the answer as the instruction.
    const q = project.db.listConcepts({ parentId: b.id, kind: "question" })[0];
    await project.answerQuestion(q?.id as string, "60 days");
    const cont = await run(
      b.id,
      async (ag) => {
        await ag.edit("momentum.py", "window = 60\n");
        await ag.checkpoint("Momentum with a 60-day window", "done");
        await ag.finish();
      },
      "The human answered: 60 days.",
    );
    expect(cont.mode).toBe("continue");
    expect(cont.agent.prompt).toContain("60 days");
    expect(cont.agent.prompt).toContain("Lessons in force");
    expect(project.getConcept(b.id)?.status).toBe("done");
  });

  it("enforces what an agent may change", async () => {
    const { project, run, goal } = await setup();
    const t = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "T",
      assignee: { type: "agent" },
    });
    const other = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Someone else's",
    });
    const errors: string[] = [];
    await run(t.id, async (a) => {
      for (const call of [
        () => a.graph("task", { op: "update", id: other.id, title: "hijacked" }),
        () => a.graph("task", { op: "create" }),
        () => a.graph("finding", { text: "" }),
      ]) {
        try {
          await call();
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      let depthErr = "";
      let parent = t.id;
      for (let i = 0; i < 4; i++) {
        try {
          parent = (
            await a.graph("task", { op: "create", title: `level ${i + 1}`, parentId: parent })
          ).id as string;
        } catch (err) {
          depthErr = (err as Error).message;
        }
      }
      errors.push(depthErr);
      const l = await a.graph("lesson", { text: "Do not trust in-sample Sharpe" });
      expect(l.message).toMatch(/proposed/);
      await a.finish();
    });
    expect(errors[0]).toMatch(/only update your own task/);
    expect(errors[1]).toMatch(/title is required/);
    expect(errors[2]).toMatch(/text is required/);
    expect(errors[3]).toMatch(/at most 3 levels/);
    expect(project.getConcept(other.id)?.title).toBe("Someone else's");
    expect(project.db.listConcepts({ kind: "lesson" })[0]).toMatchObject({
      parentId: goal.id,
      lessonState: "proposed",
    });
  });
  it("starts a task with one upstream task from its latest checkpoint, in a new conversation", async () => {
    const { project, run, goal } = await setup();
    const data = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Fetch prices",
      assignee: { type: "agent" },
    });
    await run(data.id, async (a) => {
      await a.writeFile("data/prices.csv", "day,close\n1,10\n");
      await a.checkpoint("Fetched prices", "done");
      await a.finish();
    });
    const backtest = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Backtest",
      assignee: { type: "agent" },
      dependsOn: [data.id],
    });
    const r = await run(backtest.id, async (a) => {
      expect(existsSync(join(a.workspace, "data/prices.csv"))).toBe(true);
      expect(a.prompt).toContain("Your task: Backtest");
      await a.checkpoint("Backtested", "done");
      await a.finish();
    });
    expect(r.mode).toBe("fork");
    expect(r.out.reason).toBe("done");
    const cp = project.db
      .listLinks({ from: data.id, rel: "evidence" })
      .filter((l) => l.to.type === "node")
      .at(-1)?.to.id;
    expect(project.getConcept(backtest.id)?.startFrom).toEqual({
      taskId: data.id,
      checkpointId: cp,
    });

    // Starting fresh: the repository, without the upstream task's files.
    const fresh = await project.createConcept({
      kind: "task",
      parentId: goal.id,
      title: "Backtest from scratch",
      assignee: { type: "agent" },
      dependsOn: [data.id],
      startFresh: true,
    });
    await run(fresh.id, async (a) => {
      expect(existsSync(join(a.workspace, "data/prices.csv"))).toBe(false);
      await a.checkpoint("Started over", "done");
      await a.finish();
    });
    expect(project.getConcept(fresh.id)?.startFrom ?? null).toBeNull();
  });
});
