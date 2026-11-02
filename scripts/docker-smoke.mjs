// Checks the docker sandbox without calling the API: the container starts, speaks the
// protocol, sees the workspace at /workspace without .git, and writes files the host can
// snapshot. Usage: pnpm docker:build && node scripts/docker-smoke.mjs
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerLauncher } from "../packages/core/dist/index.js";

const ws = await mkdtemp(join(tmpdir(), "turtle-smoke-ws-"));
const cc = await mkdtemp(join(tmpdir(), "turtle-smoke-cc-"));
await writeFile(join(ws, "hello.txt"), "from host\n");
const transport = await dockerLauncher({ image: process.argv[2] ?? "turtle/runner-claude:0.1" })({
  agentId: `smoke${Date.now()}`,
  branchId: "b",
  workspace: ws,
  sandbox: "docker",
  claudeConfigDir: cc,
  logFile: join(cc, "runner.log"),
  env: {},
});
const messages = [];
const results = new Map();
transport.onMessage((m) => {
  messages.push(m);
  if (m.t === "exec_result") results.get(m.id)?.(m);
});
const exec = (id, cmd) =>
  new Promise((r) => {
    results.set(id, r);
    transport.send({ t: "exec", id, cmd, timeoutSec: 30 });
  });
const closed = new Promise((r) => transport.onClose(r));
const deadline = Date.now() + 60_000;
while (!messages.some((m) => m.t === "ready") && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 200));

const checks = {};
const ready = messages.find((m) => m.t === "ready");
checks["runner announced ready"] = ready?.adapter === "claude-agent-sdk";
const r1 = await exec(
  1,
  "cat hello.txt && pwd && id -u && ls -a && echo written > from-container.txt",
);
checks["exec ran in /workspace"] = r1.exitCode === 0 && r1.stdout.includes("/workspace");
checks["workspace mounted (host file visible)"] = r1.stdout.includes("from host");
checks["no .git in workspace"] = !r1.stdout.split("\n").includes(".git");
checks["runs as non-root"] = !/^0$/m.test(r1.stdout.split("\n")[2] ?? "");
checks["container writes reach the host"] =
  (await readFile(join(ws, "from-container.txt"), "utf8").catch(() => "")) === "written\n";
const r2 = await exec(2, "printenv CLAUDE_CONFIG_DIR HOME");
checks["CLAUDE_CONFIG_DIR and HOME set"] =
  r2.stdout.includes("/turtle/claude") && r2.stdout.includes("/tmp/home");
transport.send({ t: "shutdown" });
const code = await Promise.race([
  closed,
  new Promise((r) => setTimeout(() => r("timeout"), 20_000)),
]);
checks["shuts down cleanly"] = code === 0;
checks["host can stat the written file"] = Boolean(
  await stat(join(ws, "from-container.txt")).catch(() => null),
);

for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"} ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
