import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { SandboxMode } from "../db/types.js";
import { OpsError } from "../ops.js";
import { ROOT_FALLBACK_ID } from "./docker.js";

/**
 * Scripts turtle runs itself: checks and recipes (architecture §3.7). They run in the
 * same sandbox as the task's agent: on the host, or in a container with the working
 * directory mounted at /workspace.
 */
export type ScriptSandbox = { mode: "none" } | { mode: "docker"; image: string; docker?: string };

export function scriptSandbox(mode: SandboxMode, image: string): ScriptSandbox {
  return mode === "docker" ? { mode: "docker", image } : { mode: "none" };
}

export const INTERPRETER: Record<string, string> = {
  ".py": "python3",
  ".sh": "bash",
  ".js": "node",
  ".mjs": "node",
};

/** Python helpers every check and recipe can import (`from turtle_check import *`). */
export const PYTHON_HELPERS = `"""turtle helpers for checks and recipes (architecture §3.7).

    from turtle_check import *

    rows = read_csv("results/power.csv")
    expect_within(mean(column(rows, "power_mw")), 805, rel=0.03, what="mean power (mW)")
    expect(len(rows) >= 3, "at least 3 runs")
    done()
"""
import csv
import math
import os
import sys

_problems = []


def read_csv(path):
    """Rows of a CSV file as dicts."""
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def column(rows, name):
    """One column of read_csv() rows, as floats."""
    return [float(r[name]) for r in rows]


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else float("nan")


def within(actual, expected, rel=0.03, abs_tol=0.0):
    """True when actual is within rel (a fraction, 0.03 = 3%) or abs_tol of expected."""
    return math.isclose(float(actual), float(expected), rel_tol=rel, abs_tol=abs_tol)


def expect(condition, message):
    """Record a problem when condition is false. Returns condition."""
    if not condition:
        _problems.append(str(message))
    return bool(condition)


def expect_within(actual, expected, rel=0.03, abs_tol=0.0, what="value"):
    ok = within(actual, expected, rel, abs_tol)
    expect(ok, f"{what}: {actual} is not within {rel:.1%} of {expected}")
    return ok


def param(name, default=None):
    """A recipe parameter (an environment variable)."""
    return os.environ.get(name, default)


def done(message="ok"):
    """Exit 1 with the problems found, or 0 with message."""
    if _problems:
        print("\\n".join(_problems))
        sys.exit(1)
    print(message)
    sys.exit(0)
`;

const MAX_OUTPUT = 4000;

export interface ScriptRun {
  ok: boolean;
  /** Exit code; null when it could not start or timed out. */
  code: number | null;
  output: string;
  ms: number;
  timedOut: boolean;
}

/** Variables that look like credentials never reach a script. */
const SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL|_KEY$)/i;

/** `docker run` arguments for a script, exported for tests. */
export function scriptDockerArgs(
  sb: { image: string },
  o: {
    cwd: string;
    scriptDir: string;
    interpreter: string;
    file: string;
    env: Record<string, string>;
  },
  host: { uid: number; gid: number },
): string[] {
  const args = [
    "run",
    "--rm",
    "--user",
    `${host.uid}:${host.gid}`,
    "-v",
    `${o.cwd}:/workspace`,
    "-v",
    `${o.scriptDir}:/turtle-script:ro`,
    "-w",
    "/workspace",
    "-e",
    "HOME=/tmp/home",
    "-e",
    "PYTHONPATH=/turtle-script",
  ];
  for (const [k, v] of Object.entries(o.env)) args.push("-e", `${k}=${v}`);
  args.push(sb.image, o.interpreter, `/turtle-script/${o.file}`);
  return args;
}

/**
 * Run a script (a check or a recipe) with `cwd` as its working directory. The script and
 * the helpers are written to a fresh temporary directory outside `cwd`. Exit code 0 is
 * success; the output (stdout and stderr, tail kept) explains it.
 */
export async function runScript(o: {
  file: string;
  script: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  sandbox?: ScriptSandbox;
}): Promise<ScriptRun> {
  const interpreter = INTERPRETER[extname(o.file).toLowerCase()];
  if (!interpreter) throw new OpsError(`no interpreter for ${o.file}`);
  const dir = await mkdtemp(join(tmpdir(), "turtle-script-"));
  const started = Date.now();
  try {
    await writeFile(join(dir, o.file), o.script, { mode: 0o644 });
    await writeFile(join(dir, "turtle_check.py"), PYTHON_HELPERS, { mode: 0o644 });
    const extra = { ...(o.env ?? {}), PYTHONDONTWRITEBYTECODE: "1" };
    let cmd: string;
    let args: string[];
    let env: Record<string, string>;
    const sb = o.sandbox ?? { mode: "none" };
    if (sb.mode === "docker") {
      const uid = process.getuid?.() ?? ROOT_FALLBACK_ID;
      const gid = process.getgid?.() ?? ROOT_FALLBACK_ID;
      cmd = sb.docker ?? "docker";
      args = scriptDockerArgs(
        sb,
        { cwd: o.cwd, scriptDir: dir, interpreter, file: o.file, env: extra },
        uid === 0 ? { uid: ROOT_FALLBACK_ID, gid: ROOT_FALLBACK_ID } : { uid, gid },
      );
      env = { PATH: process.env.PATH ?? "" };
      for (const k of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "HOME"])
        if (process.env[k]) env[k] = process.env[k] as string;
    } else {
      cmd = interpreter;
      args = [join(dir, o.file)];
      env = {};
      for (const [k, v] of Object.entries(process.env))
        if (v !== undefined && !SECRET.test(k)) env[k] = v;
      env.PYTHONPATH = [dir, process.env.PYTHONPATH].filter(Boolean).join(":");
      Object.assign(env, extra);
    }
    const r = await spawnCollect(cmd, args, o.cwd, env, o.timeoutMs);
    const ms = Date.now() - started;
    if (r.error)
      return {
        ok: false,
        code: null,
        output: `could not run ${cmd}: ${r.error}`,
        ms,
        timedOut: false,
      };
    const output = clip(r.output);
    if (r.timedOut)
      return {
        ok: false,
        code: null,
        output: `${output}\n(timed out after ${Math.round(ms / 1000)} s)`.trim(),
        ms,
        timedOut: true,
      };
    return {
      ok: r.code === 0,
      code: r.code,
      output: output || (r.code === 0 ? "passed" : `exit code ${r.code}`),
      ms,
      timedOut: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spawnCollect(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const add = (d: Buffer) => {
      output += d.toString("utf8");
      // Keep the tail: the end of a failing script's output explains it.
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (r: { code: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, output, timedOut });
    };
    child.on("error", (err) => finish({ code: null, error: err.message }));
    child.on("close", (code) => finish({ code }));
  });
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUTPUT ? `…${t.slice(-MAX_OUTPUT)}` : t;
}
