import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxMode } from "./db/types.js";

export interface RulesConfig {
  maxToolCalls: number;
  maxMinutes: number;
  maxChangedLines: number;
  maxChangedFiles: number;
  testFlip: boolean;
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TurtleConfig {
  agent: {
    adapter: string;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    allowedTools: string[];
  };
  sandbox: { mode: SandboxMode; image: string };
  workspace: { copyIgnored: string[]; setupCommand?: string };
  checkpoint: { summarizerModel: string; rules: RulesConfig };
  tests: { command?: string; runAtCheckpoint: boolean; timeoutSec: number };
  prices: Record<string, ModelPrice>;
}

export const DEFAULT_CONFIG: TurtleConfig = {
  agent: {
    adapter: "claude-agent-sdk",
    model: "claude-opus-5-5",
    maxTurns: 200,
    maxBudgetUsd: 10,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite", "mcp__turtle__*"],
  },
  sandbox: { mode: "docker", image: "turtle/runner-claude:0.1" },
  workspace: { copyIgnored: [".env"] },
  checkpoint: {
    summarizerModel: "claude-haiku-5-5",
    rules: {
      maxToolCalls: 25,
      maxMinutes: 10,
      maxChangedLines: 400,
      maxChangedFiles: 15,
      testFlip: true,
    },
  },
  tests: { runAtCheckpoint: false, timeoutSec: 600 },
  prices: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  },
};

export const CONFIG_FILE = "turtle.config.json";

/** Deep-merge plain objects; arrays and scalars from `override` replace `base`. */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = mergeConfig((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** Load `<dir>/turtle.config.json` merged over the defaults (missing file = defaults). */
export async function loadConfig(dir: string): Promise<TurtleConfig> {
  let text: string;
  try {
    text = await readFile(join(dir, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw err;
  }
  return mergeConfig(structuredClone(DEFAULT_CONFIG), JSON.parse(text));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
