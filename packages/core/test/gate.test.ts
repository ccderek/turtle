import { homedir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { GitStore } from "../src/git/store.js";
import { auditTasks, checkExport, exportText } from "../src/project/audit.js";
import { buildExport, redact, scanForLeaks } from "../src/project/export.js";
import { computeGate, readAudits, recordJudgment } from "../src/project/gate.js";
import { Project } from "../src/project/project.js";
import { startTaskRun } from "../src/project/task-run.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import { type FakeScript, fakeLauncher } from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

async function setup() {
  const home = await tempDir("turtle-home-");
  process.env.TURTLE_HOME = home;
  const repo = await makeRepo({ "README.md": "phone lab\n" });
  const project = await Project.ensureForRepo(await GitStore.open(repo), { home });
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const workspaceRoot = await tempDir("turtle-ws-");
  const run = async (taskId: string, script: FakeScript) => {
    const r = await startTaskRun(project, taskId, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => fakeLauncher(script),
      workspaceRoot,
    });
    await r.session.done;
    r.close();
  };
  const goal = await project.createConcept({
    kind: "goal",
    parentId: null,
    title: "Measure model A on a phone",
  });
  const task = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: "Measure power",
    assignee: { type: "agent" },
  });
  await run(task.id, async (a) => {
    await a.tool("Bash", { command: "python3 measure.py --rate 10k" }, { response: "3 runs" });
    await a.writeFile("results/power.csv", "run,power_mw\n1,812\n2,798\n");
    await a.graph("finding", {
      text: "Average 805 mW over 3 runs",
      evidence: [{ path: "results/power.csv" }],
    });
    await a.graph("finding", { text: "Probably thermal throttling after run 3" });
    await a.graph("decision", { text: "Sample at 10 kHz" });
    await a.checkpoint("Measured power", "done");
    await a.graph("brief", {
      text: `Done. 805 mW. Logs in ${homedir()}/lab/logs; ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwx`,
    });
    await a.finish();
  });
  return { project, goal, task, run };
}

describe("export (docs/phase2-spec.md §10)", () => {
  it("redacts home paths and secrets, and finds what is left", () => {
    const counts: Record<string, number> = {};
    const out = redact(
      `cd ${homedir()}/x && GITHUB_TOKEN=ghp_${"a".repeat(36)} /Users/derek/y Bearer abcdefghijklmnopqrstuvwxyz`,
      counts,
    );
    expect(out).not.toContain(homedir());
    expect(out).not.toContain("derek");
    expect(out).toContain("GITHUB_TOKEN=[redacted]");
    expect(out).toContain("Bearer [redacted]");
    expect(counts["home path"]).toBe(2);
    expect(scanForLeaks(out)).toEqual([]);
    expect(scanForLeaks("key sk-ant-abcdefghijklmnopqrstuvwxyz")).toHaveLength(1);
  });

  it("writes one self-contained HTML file with briefs, evidence inlined and no secrets", async () => {
    const { project, goal } = await setup();
    const e = await buildExport(project, goal.id, { now: new Date("2026-11-13T10:00:00Z") });
    expect(e.fileName).toBe("measure-model-a-on-a-phone-2026-11-13.html");
    expect(e.counts).toMatchObject({ goals: 1, tasks: 1, findings: 2, decisions: 1 });
    expect(e.inlined).toBe(1);
    expect(e.html).toContain("<td>812</td>");
    expect(e.html).toContain("claimed: no evidence attached");
    expect(e.html).toContain("Sample at 10 kHz");
    expect(e.html).not.toContain(homedir());
    expect(e.html).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(e.html).not.toContain("python3 measure.py"); // no transcripts or tool logs
    expect(e.redactions).toMatchObject({ "home path": 1 });
    expect(e.leaks).toEqual([]);
    expect(exportText(e.html)).toContain("Average 805 mW over 3 runs");
  });
});

describe("gate (docs/phase2-spec.md §15)", () => {
  it("computes G1–G5 from the records, with judgments and audits", async () => {
    const { project, task } = await setup();
    let g = await computeGate(project);
    const m = (id: string) => g.groups.flatMap((x) => x.metrics).find((x) => x.id === id);
    expect(m("g1.resumable")).toMatchObject({ value: 1, pass: true });
    expect(m("g2.findings")).toMatchObject({ value: 0.5, pass: false });
    expect(m("g2.done")).toMatchObject({ value: 1, pass: true });
    expect(m("g2.audit")?.pass).toBeNull();
    expect(m("g3.judged")?.pass).toBeNull();
    expect(g.pass).toBe(false);

    // A fake model: the claimed finding is unsupported, the rest supported.
    const calls: unknown[] = [];
    const client = {
      messages: {
        parse: async (req: { messages: { content: string }[] }) => {
          calls.push(req);
          const ids = [...(req.messages[0]?.content ?? "").matchAll(/^\[([^\]]+)\]/gm)].map(
            (x) => x[1],
          );
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 100 },
            parsed_output: {
              items: ids.map((id) => ({
                id,
                verdict:
                  id && project.getConcept(id)?.title.startsWith("Probably")
                    ? "unsupported"
                    : "supported",
                reason: "seen in the log",
              })),
            },
          };
        },
      },
    } as unknown as Anthropic;
    const audits = await auditTasks(project, {
      client,
      model: "claude-haiku-5-5",
      prices: DEFAULT_CONFIG.prices,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.items.map((i) => i.kind).sort()).toEqual([
      "brief",
      "decision",
      "finding",
      "finding",
      "status",
    ]);
    expect(JSON.stringify(calls[0])).toContain("python3 measure.py --rate 10k");
    expect((await readAudits(project))[task.id]?.agreement).toBeCloseTo(0.8);
    // An unchanged task is not audited again.
    expect(await auditTasks(project, { client, model: "x", prices: {} })).toHaveLength(0);

    for (const t of ["a", "b", "c"])
      await recordJudgment(project, {
        conceptId: t,
        title: t,
        at: new Date().toISOString(),
        by: "m",
        clear: { goal: true, results: true, decisions: true, openQuestions: t !== "c" },
        redactions: 0,
        leaks: [],
      });
    g = await computeGate(project);
    expect(m("g2.audit")).toMatchObject({ value: 0.8, pass: false });
    expect(m("g3.judged")).toMatchObject({ display: "2 of 3", pass: false });
    expect(m("g4.tokens")?.value).toBeGreaterThan(0);
    expect(g.groups.map((x) => x.id)).toEqual(["G1", "G2", "G3", "G4", "G5", "latency"]);

    const check = await checkExport("report", {
      client: {
        messages: {
          parse: async () => ({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 10 },
            parsed_output: {
              goal: { clear: true, answer: "x" },
              results: { clear: true, answer: "x" },
              decisions: { clear: true, answer: "x" },
              openQuestions: { clear: false, answer: "?" },
            },
          }),
        },
      } as unknown as Anthropic,
      model: "claude-haiku-5-5",
      prices: DEFAULT_CONFIG.prices,
    });
    expect(check.openQuestions.clear).toBe(false);
  });
});
