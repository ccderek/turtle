import { spawn } from "node:child_process";

export interface GitRunOptions {
  /** Value for GIT_DIR. */
  gitDir?: string;
  /** Value for GIT_WORK_TREE. */
  workTree?: string;
  /** Value for GIT_INDEX_FILE. */
  indexFile?: string;
  /** Working directory for the git process. */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Data written to stdin. */
  input?: string | Buffer;
  /** Exit codes treated as success (default: [0]). */
  okCodes?: number[];
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/** Run git and capture output. Rejects with GitError on a non-ok exit code. */
export function runGit(args: readonly string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...opts.env,
  };
  if (opts.gitDir) env.GIT_DIR = opts.gitDir;
  if (opts.workTree) env.GIT_WORK_TREE = opts.workTree;
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  const okCodes = opts.okCodes ?? [0];

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === null || !okCodes.includes(code)) {
        reject(new GitError(args, code, stderr));
        return;
      }
      resolve({ stdout: Buffer.concat(out), stderr, exitCode: code });
    });
    child.stdin.on("error", () => {
      // git may exit before reading stdin; the close handler reports the real error.
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** Run git and return trimmed stdout as text. */
export async function git(args: readonly string[], opts: GitRunOptions = {}): Promise<string> {
  const { stdout } = await runGit(args, opts);
  return stdout.toString("utf8").trim();
}
