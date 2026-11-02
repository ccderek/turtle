// Real end-to-end run against the Claude API (costs a few cents with Haiku).
// Exercises: new branch → need_decision → continue → fork from a mid-run checkpoint.
// Usage: pnpm build && node scripts/e2e-real.mjs [model]
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  GitStore,
  git,
  HeuristicSummarizer,
  mergeConfig,
  noneLauncher,
  RunSession,
  TurtleDb,
} from "../packages/core/dist/index.js";

const model = process.argv[2] ?? "claude-haiku-5-5";
const runnerMain = fileURLToPath(
  new URL("../packages/runner-claude/dist/main.js", import.meta.url),
);
const repo = await mkdtemp(join(tmpdir(), "turtle-e2e-"));
await git(["init", "-q", "-b", "main"], { cwd: repo });
await writeFile(join(repo, "README.md"), "# demo\n");
await git(["add", "-A"], { cwd: repo });
await git(["-c", "user.name=e2e", "-c", "user.email=e2e@x", "commit", "-q", "-m", "init"], {
  cwd: repo,
});

const store = await GitStore.open(repo);
const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
  sandbox: { mode: "none" },
  agent: { model, maxTurns: 15, maxBudgetUsd: 1 },
});
const deps = {
  store,
  db,
  config,
  summarizer: new HeuristicSummarizer(),
  workspaceRoot: `${repo}-ws`,
  launcher: noneLauncher([process.execPath, runnerMain]),
  onEvent: (e) => {
    if (e.type === "node" && e.node.kind !== "micro")
      console.log(
        `  ◆ ${e.node.id.slice(0, 6)} ${e.node.status} ${e.node.trigger} — ${(e.node.summary ?? "").split("\n")[0]}`,
      );
    else if (e.type === "tool") console.log(`  · ${e.name} ${e.detail}`);
    else if (e.type === "log") console.log(`  [${e.level}] ${e.message}`);
    else if (e.type === "ended")
      console.log(
        `  = ${e.outcome.reason} cost=$${e.outcome.costUsd?.toFixed(4)} ${e.outcome.error ?? ""}`,
      );
  },
};

async function run(label, opts) {
  console.log(`\n## ${label}`);
  const s = await RunSession.start(deps, opts);
  const out = await s.done;
  return { s, out };
}

const a = await run("new branch", {
  prompt:
    "Create a file hello.txt containing the single line 'hello'. Then call the turtle checkpoint tool with " +
    "status need_decision and the summary 'Add hello.txt' plus a question asking whether to also add bye.txt. Then stop.",
});
const head = db.getBranch(a.s.branchId).headNodeId;
const b = await run("continue (answer)", {
  from: head,
  prompt: "Yes. Create bye.txt containing 'bye', then finish.",
});
const declared = db
  .listNodes({ branchId: a.s.branchId, kinds: ["semantic"] })
  .find((n) => n.trigger === "declared");
const c = await run("fork from the declared checkpoint", {
  from: declared.id,
  prompt:
    "No bye.txt. Instead create ciao.txt containing 'ciao'. Also tell me in one line which files you created earlier in this conversation.",
});

const ws = (s) => s.workspace;
const read = async (p) => readFile(p, "utf8").catch(() => "(missing)");
const checks = {
  "A: declared node has a resume point": Boolean(declared?.resumeMessageUuid),
  "A: outcome need_decision": a.out.reason === "need_decision",
  "B: continued the same branch": b.s.branchId === a.s.branchId && b.s.mode === "continue",
  "B: bye.txt exists": (await read(join(ws(b.s), "bye.txt"))).trim() === "bye",
  "C: forked into a new branch": c.s.mode === "fork" && c.s.branchId !== a.s.branchId,
  "C: resumed (not a fresh session)":
    Boolean(db.getAgent(c.s.agentId).sessionId) && c.out.reason !== "failed",
  "C: ciao.txt exists, bye.txt absent":
    (await read(join(ws(c.s), "ciao.txt"))).trim() === "ciao" &&
    (await read(join(ws(c.s), "bye.txt"))) === "(missing)",
};
const lastText = db
  .listMessages(c.s.agentId)
  .filter((m) => m.type === "assistant")
  .map((m) =>
    JSON.parse(m.json)
      .message.content.filter((x) => x.type === "text")
      .map((x) => x.text)
      .join(""),
  )
  .filter(Boolean)
  .at(-1);
console.log(`\nfork agent's last words: ${lastText}`);
console.log("\nchecks:");
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? "PASS" : "FAIL"} ${k}`);
console.log(`\nrepo: ${repo}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
