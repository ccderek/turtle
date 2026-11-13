// G1 check against the Claude API (docs/phase2-spec.md §15): a task makes three checkpoints,
// then three tasks start from each of them ("new task from here"). Each fork must restore
// the files and continue without redoing a finished step. Costs a few cents with Haiku.
// Usage: pnpm build && node scripts/e2e-rewind.mjs [model]   (--fake: scripted agent, no API)
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeGate,
  DEFAULT_CONFIG,
  fakeLauncher,
  GitStore,
  git,
  HeuristicSummarizer,
  mergeConfig,
  noneLauncher,
  Project,
  startTaskRun,
  TurtleDb,
} from "../packages/core/dist/index.js";

const fake = process.argv.includes("--fake");
const model = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "claude-haiku-5-5";
if (!fake && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  process.exit(2);
}
const runnerMain = fileURLToPath(
  new URL("../packages/runner-claude/dist/main.js", import.meta.url),
);
const repo = await mkdtemp(join(tmpdir(), "turtle-rewind-"));
process.env.TURTLE_HOME = `${repo}-home`;
await git(["init", "-q", "-b", "main"], { cwd: repo });
await writeFile(join(repo, "README.md"), "# rewind test\n");
await git(["add", "-A"], { cwd: repo });
await git(["-c", "user.name=e2e", "-c", "user.email=e2e@x", "commit", "-q", "-m", "init"], {
  cwd: repo,
});

const store = await GitStore.open(repo);
const project = await Project.ensureForRepo(store);
const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
  sandbox: { mode: "none" },
  agent: { model, maxTurns: 25, maxBudgetUsd: 1 },
});
const deps = {
  config,
  summarizer: new HeuristicSummarizer(),
  // --fake checks this script itself with a scripted agent (no model, no cost).
  launcherFor: () =>
    fake
      ? fakeLauncher(async (a) => {
          const after = Number(/Continue after step (\d)/.exec(a.prompt)?.[1] ?? 0);
          for (let j = after + 1; j <= 3; j++) {
            await a.writeFile(`step${j}.txt`, `${j}\n`);
            await a.checkpoint(`Step ${j}: step${j}.txt`, j === 3 ? "done" : "progress");
          }
          if (after === 3) await a.checkpoint("Nothing left to do", "done");
          await a.finish();
        })
      : noneLauncher([process.execPath, runnerMain]),
  workspaceRoot: `${repo}-ws`,
  onEvent: (e) => {
    if (e.type === "node" && e.node.kind === "semantic")
      console.log(
        `  ◆ ${e.node.id.slice(0, 6)} ${e.node.status} — ${(e.node.summary ?? "").split("\n")[0]}`,
      );
    else if (e.type === "tool") console.log(`  · ${e.name} ${e.detail}`);
    else if (e.type === "ended")
      console.log(
        `  = ${e.outcome.reason} $${e.outcome.costUsd?.toFixed(4) ?? "?"} ${e.outcome.error ?? ""}`,
      );
  },
};
const run = async (taskId) => {
  const r = await startTaskRun(project, taskId, deps);
  const out = await r.session.done;
  r.close();
  return out;
};

const goal = await project.createConcept({ kind: "goal", parentId: null, title: "Three steps" });
const task = await project.createConcept({
  kind: "task",
  parentId: goal.id,
  title: "Write three files, one step at a time",
  assignee: { type: "agent" },
  body:
    "Step 1: create step1.txt containing the line 1, then call the turtle checkpoint tool with the summary 'Step 1: step1.txt'. " +
    "Step 2: create step2.txt containing 2, then checkpoint 'Step 2: step2.txt'. " +
    "Step 3: create step3.txt containing 3, then checkpoint 'Step 3: step3.txt' with status done. Do nothing else.",
});
console.log("\n## the original task");
await run(task.id);

const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
const t = project.getConcept(task.id);
const branchId = t.branches?.[0]?.branch;
const cps = db
  .listNodes({ branchId, kinds: ["semantic"] })
  .filter((n) => n.summarySource === "agent_declared" && /Step \d/.test(n.summary ?? ""));
console.log(
  `\n${cps.length} declared checkpoints; resumable: ${cps.filter((n) => n.sessionId && n.resumeMessageUuid).length}`,
);
if (cps.length < 3) {
  console.error("the original task did not make three checkpoints; nothing to fork from");
  process.exit(1);
}

const results = [];
for (const [i, cp] of cps.slice(0, 3).entries()) {
  const k = i + 1;
  const fork = await project.createConcept({
    kind: "task",
    parentId: goal.id,
    title: `Continue after step ${k}`,
    assignee: { type: "agent" },
    startFrom: { taskId: task.id, checkpointId: cp.id },
    body:
      "Continue the work above from where it stopped: do only the steps that are not done yet, in order, with their checkpoints. " +
      "If every step is done, call the turtle checkpoint tool with status done and the summary 'Nothing left to do'.",
  });
  console.log(`\n## fork from checkpoint ${cp.id.slice(0, 6)} (after step ${k})`);
  const out = await run(fork.id);
  const f = project.getConcept(fork.id);
  const fb = db.getBranch(f.branches?.[0]?.branch ?? "");
  const ws = fb?.workspacePath ?? "";
  // (a) the files of the finished steps are there, unchanged
  const restored = [];
  for (let j = 1; j <= k; j++)
    restored.push(
      existsSync(join(ws, `step${j}.txt`)) &&
        (await readFile(join(ws, `step${j}.txt`), "utf8")).trim() === String(j),
    );
  // (b) no finished step is redone: no write to step1..k
  const writes = [];
  for (const a of db.listAgents({ branchId: fb?.id })) {
    for (const m of db.listMessages(a.id)) {
      const msg = JSON.parse(m.json);
      for (const b of msg.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const s = JSON.stringify(b.input);
        for (let j = 1; j <= k; j++)
          if (
            new RegExp(`step${j}\\.txt`).test(s) &&
            /Write|Edit|Bash/.test(b.name) &&
            !/cat |ls |Read/.test(s)
          )
            writes.push(`${b.name} step${j}.txt`);
      }
    }
  }
  const ok = out.reason !== "failed" && restored.every(Boolean) && writes.length === 0;
  results.push({ k, ok, reason: out.reason, restored, writes });
  console.log(
    `  ${ok ? "✓" : "✗"} restored ${restored.filter(Boolean).length}/${k} files; repeated: ${writes.join(", ") || "none"}`,
  );
}
db.close();

const g = await computeGate(project);
const g1 = g.groups.find((x) => x.id === "G1");
console.log("\nG1 from the records:");
for (const m of g1.metrics) console.log(`  ${m.label}: ${m.display} (${m.detail ?? ""})`);
const okCount = results.filter((r) => r.ok).length;
console.log(
  `\nforks that restored the files and did not redo a step: ${okCount} of ${results.length}`,
);
project.close();
process.exit(okCount === results.length ? 0 : 1);
