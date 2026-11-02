// Measures snapshot latency on a synthetic repo (exit criterion E3: p95 < 300 ms at 10k files).
// Usage: pnpm build && node scripts/bench-snapshot.mjs [fileCount] [iterations]
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDENTITY, GitStore, git } from "../packages/core/dist/index.js";

const fileCount = Number(process.argv[2] ?? 10_000);
const iterations = Number(process.argv[3] ?? 30);

const repo = await mkdtemp(join(tmpdir(), "turtle-bench-"));
await git(["init", "-q", "-b", "main"], { cwd: repo });
for (let i = 0; i < fileCount; i++) {
  const dir = join(repo, `src/m${i % 100}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(20));
}
await git(["add", "-A"], { cwd: repo });
await git(["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "-m", "init"], { cwd: repo });

const store = await GitStore.open(repo);
const root = await store.snapshotWorkingCopy({
  indexFile: join(store.turtleDir, "index", "root"),
  message: "root",
  identity: AGENT_IDENTITY,
  fromHead: true,
});
const ws = join(repo, "..", `${repo.split("/").pop()}-ws`);
const indexFile = store.indexFileFor("bench");
let t = performance.now();
await store.materialize(root.commit, ws, indexFile);
console.log(`files=${fileCount} materialize=${(performance.now() - t).toFixed(0)}ms`);

let parent = { commit: root.commit, tree: root.tree };
const times = [];
for (let i = 0; i < iterations; i++) {
  await writeFile(join(ws, `src/m${i % 100}/f${i}.ts`), `// edit ${i}\n`);
  t = performance.now();
  const res = await store.snapshot({
    workTree: ws, indexFile, parent, message: `micro ${i}`, identity: AGENT_IDENTITY, allowUnchanged: false,
  });
  times.push(performance.now() - t);
  if (res) parent = { commit: res.commit, tree: res.tree };
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(0);
console.log(`snapshot p50=${pct(50)}ms p95=${pct(95)}ms max=${pct(100)}ms (n=${iterations})`);
