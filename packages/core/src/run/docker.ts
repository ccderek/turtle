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

/** uid/gid used inside the container when turtle itself runs as root (the image's "node" user). */
export const ROOT_FALLBACK_ID = 1000;

export interface DockerOptions {
  image: string;
  /** Docker CLI binary (default "docker"). */
  docker?: string;
  /** Extra `docker run` arguments (e.g. ["--network", "none"]). */
  extraArgs?: string[];
  /** Additional host environment variable names to pass into the container. */
  forwardEnv?: string[];
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
  for (const name of [...FORWARDED_ENV, ...(o.forwardEnv ?? [])]) {
    // Pass by name so values never appear in the process list.
    if (host.env[name] !== undefined) args.push("-e", name);
  }
  // A host CA bundle for TLS-inspecting proxies is mounted read-only.
  const ca = host.env.NODE_EXTRA_CA_CERTS;
  if (ca) args.push("-v", `${ca}:/turtle/ca.crt:ro`, "-e", "NODE_EXTRA_CA_CERTS=/turtle/ca.crt");
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
    let uid = process.getuid?.() ?? 1000;
    let gid = process.getgid?.() ?? 1000;
    if (uid === 0) {
      // Claude Code refuses to skip permission prompts as root, so a root host runs the
      // container as the image's unprivileged user and hands it the mounted directories.
      uid = ROOT_FALLBACK_ID;
      gid = ROOT_FALLBACK_ID;
      await execFileAsync("chown", ["-R", `${uid}:${gid}`, spec.workspace, spec.claudeConfigDir]);
    }
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
