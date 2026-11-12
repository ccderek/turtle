// Offline demo (no API key): builds a small tree with a scripted agent, then shows it with
// the real `turtle` CLI. Usage: pnpm demo   (or `pnpm demo:ui` to open it in the web UI)
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  fakeLauncher,
  GitStore,
  git,
  HeuristicSummarizer,
  mergeConfig,
  Project,
  RunSession,
  startTaskRun,
  TurtleDb,
} from "../packages/core/dist/index.js";

const cli = fileURLToPath(new URL("../packages/cli/dist/main.js", import.meta.url));
const repo = await mkdtemp(join(tmpdir(), "turtle-demo-"));
process.env.TURTLE_HOME = `${repo}-home`;
await git(["init", "-q", "-b", "main"], { cwd: repo });
await writeFile(
  join(repo, "export.js"),
  "export function exportData(data) {\n  return String(data);\n}\n",
);
await git(["add", "-A"], { cwd: repo });
await git(["-c", "user.name=demo", "-c", "user.email=demo@x", "commit", "-q", "-m", "init"], {
  cwd: repo,
});

// The demo agent needs no sandbox; keep the config out of the snapshots.
await writeFile(
  join(repo, "turtle.config.json"),
  `${JSON.stringify({ sandbox: { mode: "none" } })}\n`,
);
await writeFile(join(repo, ".git", "info", "exclude"), "turtle.config.json\n");
const store = await GitStore.open(repo);
const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
  sandbox: { mode: "none" },
  tests: { command: "npm test" },
});
const run = async (prompt, script, extra = {}) => {
  const s = await RunSession.start(
    { store, db, config, summarizer: new HeuristicSummarizer(), launcher: fakeLauncher(script) },
    { prompt, ...extra },
  );
  return { s, out: await s.done };
};

const OOS_CHECK = `# The lesson "always keep 6 months out of sample", as a check.
# Every backtest result (a metric,value CSV under results/) must report out_of_sample.
import csv, pathlib, sys

missing = []
for path in sorted(pathlib.Path("results").glob("*.csv")):
    rows = list(csv.reader(path.open()))
    if rows and rows[0] == ["metric", "value"]:
        if not any(r and r[0] == "out_of_sample" for r in rows[1:]):
            missing.append(str(path))

if missing:
    print("No out-of-sample score in: " + ", ".join(missing))
    sys.exit(1)
print("Every backtest result reports an out-of-sample score.")
`;

const ui = process.argv.includes("--ui");
let first;
let decl;
if (ui) {
  await seedGraph();
} else {
  // 1. New branch: the agent adds a flag, then asks a question.
  first = await run("Add a --json option to the exporter", async (a) => {
    await a.say("I'll look at the exporter first.");
    await a.tool("Read", { file_path: "export.js" });
    await a.edit(
      "export.js",
      "export function exportData(data, opts = {}) {\n  if (opts.json) return JSON.stringify(data);\n  return String(data);\n}\n",
    );
    await a.edit(
      "cli.js",
      "import { exportData } from './export.js';\nconst json = process.argv.includes('--json');\nconsole.log(exportData({ a: 1 }, { json }));\n",
    );
    await a.tool("Bash", { command: "npm test" }, { response: { stdout: "3 passed" } });
    await a.checkpoint(
      "Add --json option parsing\n\nexportData() takes { json } and cli.js reads --json.",
    );
    await a.edit(
      "export.js",
      "export function exportData(data, opts = {}) {\n  if (opts.json) return JSON.stringify(data, null, opts.pretty ? 2 : 0);\n  return String(data);\n}\n",
    );
    await a.checkpoint("Should --json pretty-print by default?", "need_decision");
    await a.finish("Should --json pretty-print by default?");
  });
  decl = db.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] })[0];

  // 2. The human answers; the same branch continues.
  await run(
    "Yes, pretty-print by default",
    async (a) => {
      await a.edit(
        "export.js",
        "export function exportData(data, opts = {}) {\n  if (opts.json) return JSON.stringify(data, null, opts.pretty === false ? 0 : 2);\n  return String(data);\n}\n",
      );
      await a.edit("README.md", "Use --json for pretty JSON output.\n");
      await a.finish("Done: --json pretty-prints by default.");
    },
    { from: db.getBranch(first.s.branchId).headNodeId },
  );

  // 3. A different approach forked from the first checkpoint.
  await run(
    "Instead, add a separate --format=json|text option",
    async (a) => {
      await a.edit(
        "cli.js",
        "import { exportData } from './export.js';\nconst f = (process.argv.find((x) => x.startsWith('--format=')) ?? '--format=text').slice(9);\nconsole.log(exportData({ a: 1 }, { json: f === 'json' }));\n",
      );
      await a.tool("Bash", { command: "npm test" }, { response: "1 failed", failed: true });
      await a.checkpoint("Add --format option (tests failing)", "blocked");
      await a.finish("Tests fail because the fixture expects --json.");
    },
    { from: decl.id, name: "format-flag" },
  );
}

/**
 * The task-graph demo (phase2): a trading system goal where approach A was tried,
 * failed out of sample, and was abandoned into a lesson; approach B waits to start from
 * the checkpoint before A. With `turtle ui --demo-agent`, B starts on its own, then the
 * tasks that depend on it, and the last one asks you a question.
 */
async function seedGraph() {
  const project = await Project.ensureForRepo(store);
  const seedRun = async (taskId, script) => {
    const r = await startTaskRun(project, taskId, {
      config,
      summarizer: new HeuristicSummarizer(),
      launcherFor: () => fakeLauncher(script),
    });
    await r.session.done;
    r.close();
  };
  const task = (parentId, title, extra = {}) =>
    project.createConcept({ kind: "task", parentId, title, assignee: { type: "agent" }, ...extra });

  const goal = await project.createConcept({
    kind: "goal",
    parentId: null,
    title: "Build a trading system that trades every 8 hours",
    body: "Data feed, positions and execution; most details are still open.",
  });
  await project.createConcept({
    kind: "decision",
    parentId: goal.id,
    title: "Market: BTC/ETH spot (decided on day 1)",
  });

  const feed = await task(goal.id, "Data feed: pull prices and store history");
  await seedRun(feed.id, async (a) => {
    await a.edit("feed/pull.py", "def pull(): ...  # every minute, with retries\n");
    await a.writeFile("results/feed-check.csv", "minute,requests,errors\n1,1180,0\n2,1200,0\n");
    await a.graph("finding", {
      text: "The exchange API allows 1200 requests per minute",
      evidence: [{ path: "results/feed-check.csv" }],
    });
    await a.checkpoint("Data feed with retries", "done");
    await a.graph("brief", {
      text: "Done. Pulls 1-minute bars; 2 years of history stored outside git. Rate limit measured: 1200/min.",
    });
    await a.finish();
  });

  const signal = await task(goal.id, "Investment signal: decide when to buy and sell", {
    dependsOn: [feed.id],
  });
  let approachA = "";
  await seedRun(signal.id, async (a) => {
    await a.edit("signal/backtest.py", "def backtest(strategy, bars): ...\n");
    await a.checkpoint("Signal framework and backtester (r1)", "progress");
    approachA = (
      await a.graph("task", {
        op: "create",
        title: "Approach A: news sentiment",
        startFrom: "here",
      })
    ).id;
    await a.graph("brief", {
      text: "Framework and backtester ready (checkpoint r1). Trying approaches below it.",
    });
    await a.finish();
  });

  await seedRun(approachA, async (a) => {
    await a.edit("signal/sentiment.py", "def features(day): ...  # uses that day's news\n");
    await a.writeFile(
      "results/a-out-of-sample.csv",
      "period,sharpe\nin-sample,2.1\nout-of-sample,-0.3\n",
    );
    await a.graph("finding", { text: "In-sample Sharpe 2.1" });
    await a.graph("finding", {
      text: "Out-of-sample Sharpe -0.3: the features used news published after the close (look-ahead)",
      evidence: [{ path: "results/a-out-of-sample.csv" }],
    });
    await a.checkpoint("Approach A evaluated: fails out of sample", "blocked");
    await a.graph("brief", {
      text: "Blocked. Looked great in sample (2.1) but -0.3 out of sample: look-ahead in the news features.",
    });
    await a.finish("Approach A does not hold up.");
  });
  await project.abandonTask(approachA, {
    lesson:
      "Only use data known before the close of t-1, and always keep 6 months out of sample. An in-sample Sharpe alone proves nothing.",
  });
  // The lesson, hardened (architecture §3.7): every backtest result must report an
  // out-of-sample score. B is judged by it at each checkpoint.
  const lesson = project.db.listConcepts({ parentId: signal.id, kind: "lesson" })[0];
  await project.addCheck({
    on: lesson.id,
    title: "Every backtest result reports an out-of-sample score",
    file: "check_oos.py",
    script: OOS_CHECK,
  });
  const b = await project.retryTask(signal.id, "Approach B: price momentum", {
    body: "Use price momentum. Validate out of sample from the start.",
  });
  const sched = await task(goal.id, "Schedule: run the strategy every 8 hours", {
    dependsOn: [b.id],
  });
  await task(goal.id, "Go live: which exchange account should we use?", { dependsOn: [sched.id] });
}

if (ui) {
  db.close();
  console.log(
    `demo repo: ${repo}\nstarting the web UI with a scripted demo agent (Ctrl-C to stop)…`,
  );
  const extra = process.argv.slice(process.argv.indexOf("--ui") + 1);
  const child = spawn(process.execPath, [cli, "-C", repo, "ui", "--demo-agent", ...extra], {
    stdio: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  showWithCli();
}

function showWithCli() {
  const turtle = (...args) => {
    console.log(`\n$ turtle ${args.join(" ")}`);
    const r = spawnSync(process.execPath, [cli, "-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    process.stdout.write(r.stdout + r.stderr);
  };
  turtle("log");
  turtle("status");
  const firstShort = decl.id.slice(0, 6);
  turtle("show", firstShort, "--diff");
  turtle("tag", firstShort, "json-flag-v1");
  turtle("export", db.getBranch(first.s.branchId).headNodeId.slice(0, 6), "--branch", "feat/json");
  turtle("stats");
  turtle("doctor");
  console.log(`\ndemo repo: ${repo}  (try: node ${cli} -C ${repo} log --all)`);
}
