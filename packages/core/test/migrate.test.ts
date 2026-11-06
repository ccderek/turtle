import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { TurtleDb } from "../src/db/db.js";
import { GitStore } from "../src/git/store.js";
import { IMPORTED_GOAL_TITLE, importSourceBranches } from "../src/project/migrate.js";
import { Project } from "../src/project/project.js";
import { RunSession } from "../src/run/session.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

describe("importing Phase 0–1 runs", () => {
  it("turns branches into tasks once, with forks, questions and evidence", async () => {
    const home = await tempDir("turtle-home-");
    process.env.TURTLE_HOME = home;
    const repo = await makeRepo({ "a.txt": "a\n" });
    const store = await GitStore.open(repo);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
    const run = async (
      prompt: string,
      script: FakeScript,
      extra: { from?: string; name?: string } = {},
    ) => {
      const s = await RunSession.start(
        {
          store,
          db,
          config,
          summarizer: new HeuristicSummarizer(),
          launcher: fakeLauncher(script),
        },
        { prompt, ...extra },
      );
      return { s, out: await s.done };
    };
    const first = await run("Add a CSV export", async (a) => {
      await a.edit("b.txt", "b\n");
      await a.checkpoint("Outline CSV export");
      await a.edit("c.txt", "c\n");
      await a.checkpoint("Which delimiter?", "need_decision");
      await a.finish("Which delimiter?");
    });
    const outline = db.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] })[0];
    const fork = await run(
      "Try TSV",
      async (a) => {
        await a.edit("t.txt", "t\n");
        await a.checkpoint("TSV export", "done");
        await a.finish();
      },
      { from: outline?.id as string, name: "tsv" },
    );

    const project = await Project.ensureForRepo(store, { home });
    const source = project.config.sources[0]?.id as string;
    const tasks = await importSourceBranches(project, source, db);
    expect(tasks).toHaveLength(2);
    const [t1, t2] = tasks;
    const goal = project.db.listConcepts({ kind: "goal" })[0];
    expect(goal?.title).toBe(IMPORTED_GOAL_TITLE);
    expect(t1).toMatchObject({
      title: "Add a CSV export",
      status: "need_decision",
      parentId: goal?.id,
      branches: [{ source, branch: first.s.branchId }],
    });
    expect(project.db.listConcepts({ kind: "question", parentId: t1?.id })[0]?.title).toBe(
      "Which delimiter?",
    );
    expect(t2).toMatchObject({
      title: "tsv",
      status: "done",
      startFrom: { taskId: t1?.id, checkpointId: outline?.id },
      branches: [{ source, branch: fork.s.branchId }],
    });
    expect(
      project.db
        .listLinks({ from: t2?.id })
        .map((l) => l.rel)
        .sort(),
    ).toEqual(["evidence", "reuses"]);

    // Idempotent.
    expect(await importSourceBranches(project, source, db)).toEqual([]);
    expect(project.db.listConcepts({ kind: "task" })).toHaveLength(2);
  });
});
