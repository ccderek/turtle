import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../src/git/exec.js";

/** Isolate tests from the machine's git config. */
export const isolatedEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
Object.assign(process.env, isolatedEnv);

export async function tempDir(prefix = "turtle-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** Create a repo with an initial commit containing `files`. */
export async function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }) {
  const dir = await tempDir("turtle-repo-");
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await git(["config", "user.name", "Test User"], { cwd: dir });
  await git(["config", "user.email", "test@example.com"], { cwd: dir });
  if (Object.keys(files).length > 0) {
    await writeFiles(dir, files);
    await git(["add", "-A"], { cwd: dir });
    await git(["commit", "-q", "-m", "initial"], { cwd: dir });
  }
  return dir;
}
