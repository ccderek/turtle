// Builds the runner image (docs/phase0-spec.md §11). The runner and protocol builds are
// staged into docker/.stage; npm installs the SDK inside the image so the native Claude
// Code binary matches the container's platform, not the host's.
// Usage: pnpm docker:build [tag]
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tag = process.argv[2] ?? "turtle/runner-claude:0.1";
const stage = `${root}docker/.stage`;
await rm(stage, { recursive: true, force: true });
await mkdir(`${stage}/runner`, { recursive: true });
await mkdir(`${stage}/protocol`, { recursive: true });

await cp(`${root}packages/protocol/dist`, `${stage}/protocol/dist`, { recursive: true });
const protocolPkg = JSON.parse(await readFile(`${root}packages/protocol/package.json`, "utf8"));
await writeFile(
  `${stage}/protocol/package.json`,
  JSON.stringify({ ...protocolPkg, dependencies: {} }, null, 2),
);

await cp(`${root}packages/runner-claude/dist`, `${stage}/runner/dist`, { recursive: true });
const runnerPkg = JSON.parse(await readFile(`${root}packages/runner-claude/package.json`, "utf8"));
const deps = { ...runnerPkg.dependencies, "@turtle/protocol": "file:../protocol" };
await writeFile(
  `${stage}/runner/package.json`,
  JSON.stringify(
    {
      name: "turtle-runner",
      private: true,
      type: "module",
      bin: runnerPkg.bin,
      dependencies: deps,
    },
    null,
    2,
  ),
);

// Proxy and CA settings of the host are passed through, so builds work behind
// corporate proxies. A proxy on localhost is only reachable with --network host.
const args = ["build"];
for (const k of ["HTTPS_PROXY", "NO_PROXY"]) if (process.env[k]) args.push("--build-arg", k);
if (/\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.HTTPS_PROXY ?? ""))
  args.push("--network", "host");
const ca = process.env.NODE_EXTRA_CA_CERTS;
if (ca) args.push("--secret", `id=extra_ca,src=${ca}`);
args.push("-t", tag, "-f", `${root}docker/runner-claude.Dockerfile`, `${root}docker`);
execFileSync("docker", args, { stdio: "inherit" });
console.log(`built ${tag}`);
