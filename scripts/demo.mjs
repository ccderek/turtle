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
  RunSession,
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

// 1. New branch: the agent adds a flag, then asks a question.
const first = await run("Add a --json option to the exporter", async (a) => {
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
const decl = db.listNodes({ branchId: first.s.branchId, kinds: ["semantic"] })[0];

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

if (process.argv.includes("--ui")) {
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
