import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { childProcessTransport, type RunnerLauncher, type RunnerTransport } from "./transport.js";

const execFileAsync = promisify(execFile);

/** Environment variables forwarded into the container when set on the host. */
export const FORWARDED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

export interface DockerOptions {
  image: string;
  /** Docker CLI binary (default "docker"). */
  docker?: string;
  /** Extra `docker run` arguments (e.g. ["--network", "none"]). */
  extraArgs?: string[];
}

/** Arguments for `docker run`, exported for tests (docs/phase0-spec.md §11). */
export function dockerRunArgs(
  o: DockerOptions,
  spec: {
    agentId: string;
    workspace: string;
    claudeConfigDir: string;
    env: Record<string, string>;
  },
  host: { uid: number; gid: number; env: NodeJS.ProcessEnv },
): string[] {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    `turtle-${spec.agentId}`,
    "--user",
    `${host.uid}:${host.gid}`,
    "-v",
    `${spec.workspace}:/workspace`,
    "-v",
    `${spec.claudeConfigDir}:/turtle/claude`,
    "-w",
    "/workspace",
    "-e",
    "CLAUDE_CONFIG_DIR=/turtle/claude",
    "-e",
    "HOME=/tmp/home",
  ];
  for (const name of FORWARDED_ENV) {
    // Pass by name so values never appear in the process list.
    if (host.env[name] !== undefined) args.push("-e", name);
  }
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
  args.push(...(o.extraArgs ?? []), o.image, "turtle-runner");
  return args;
}

/**
 * `docker` sandbox: the runner runs in a container with the workspace mounted at
 * /workspace and no .git, so the agent cannot touch refs.
 */
export function dockerLauncher(o: DockerOptions): RunnerLauncher {
  const docker = o.docker ?? "docker";
  return async (spec): Promise<RunnerTransport> => {
    try {
      await execFileAsync(docker, ["image", "inspect", o.image]);
    } catch {
      throw new Error(
        `docker image ${o.image} not found (or docker is unavailable). Build it with ` +
          `"pnpm docker:build", or run with --sandbox none.`,
      );
    }
    await mkdir(spec.claudeConfigDir, { recursive: true });
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const transport = await childProcessTransport(
      docker,
      dockerRunArgs(o, spec, { uid, gid, env: process.env }),
      {
        env: process.env,
        logFile: spec.logFile,
      },
    );
    return {
      ...transport,
      send: transport.send,
      onMessage: transport.onMessage,
      onClose: transport.onClose,
      kill() {
        execFile(docker, ["kill", `turtle-${spec.agentId}`], () => transport.kill());
      },
    };
  };
}
