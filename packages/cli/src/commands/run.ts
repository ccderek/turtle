import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  AnthropicSummarizer,
  dockerLauncher,
  FallbackSummarizer,
  HeuristicSummarizer,
  noneLauncher,
  type RunEvent,
  type RunnerLauncher,
  type RunOptions,
  RunSession,
  type SandboxMode,
  type Summarizer,
  type TurtleConfig,
} from "@turtle/core";
import { CliError, type Context, resolveNode, shortIds } from "../context.js";
import { c, firstLine, money, nodeLine, truncate } from "../render.js";

export interface RunCliOptions {
  from?: string;
  fork?: boolean;
  fromHead?: boolean;
  sandbox?: SandboxMode;
  model?: string;
  budget?: string;
  name?: string;
  verbose?: boolean;
}

export function runnerMainPath(): string {
  return createRequire(import.meta.url).resolve("@turtle/runner-claude/main");
}

export function launcherFor(mode: SandboxMode, config: TurtleConfig): RunnerLauncher {
  if (mode === "none") return noneLauncher([process.execPath, runnerMainPath()]);
  return dockerLauncher({
    image: config.sandbox.image,
    extraArgs: config.sandbox.dockerArgs ?? [],
    forwardEnv: config.sandbox.forwardEnv ?? [],
  });
}

export function summarizerFor(config: TurtleConfig, warn: (msg: string) => void): Summarizer {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
    return new HeuristicSummarizer();
  let warned = false;
  return new FallbackSummarizer(
    new AnthropicSummarizer(config.checkpoint.summarizerModel, config.prices),
    new HeuristicSummarizer(),
    (err) => {
      if (!warned)
        warn(
          `summarizer unavailable, using plain summaries: ${err instanceof Error ? err.message : err}`,
        );
      warned = true;
    },
  );
}

export async function runCommand(ctx: Context, prompt: string, o: RunCliOptions): Promise<number> {
  const { store, db, config } = ctx;
  const sandbox = o.sandbox ?? config.sandbox.mode;
  if (sandbox !== "none" && sandbox !== "docker") throw new CliError(`unknown sandbox: ${sandbox}`);
  const opts: RunOptions = { prompt, sandbox };
  if (o.from) opts.from = resolveNode(db, o.from).id;
  if (o.fork) opts.fork = true;
  if (o.fromHead) opts.fromHead = true;
  if (o.model) opts.model = o.model;
  if (o.name) opts.name = o.name;
  if (o.budget) {
    const budget = Number(o.budget);
    if (!Number.isFinite(budget) || budget <= 0)
      throw new CliError(`invalid --budget: ${o.budget}`);
    opts.maxBudgetUsd = budget;
  }

  let short = shortIds(db);
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const onEvent = (e: RunEvent) => {
    switch (e.type) {
      case "started": {
        short = shortIds(db);
        const what =
          e.mode === "new"
            ? `new branch from ${firstLine(e.root.summary).replace(/^root: /, "")}`
            : e.mode === "continue"
              ? `continuing from ${short(e.root.id)}`
              : `fork of ${short(e.root.id)}${e.resumed ? "" : c.dim(" (no resume point: summaries added to the prompt)")}`;
        print(`${c.bold(`branch ${short(e.branch.id)}`)}  ${what}  ${c.dim(`[${sandbox}]`)}`);
        return;
      }
      case "tool":
        print(c.dim(`  · ${e.name.padEnd(7)} ${truncate(e.detail, 70)}`));
        return;
      case "assistant_text":
        if (o.verbose) print(c.dim(`  “${truncate(firstLine(e.text), 90)}”`));
        return;
      case "node":
        short = shortIds(db);
        if (e.node.kind !== "micro" || o.verbose) print(`  ${nodeLine(e.node, short)}`);
        return;
      case "tests":
        print(e.status === "pass" ? c.green("  tests passed") : c.red("  tests failed"));
        return;
      case "log":
        if (e.level !== "info" || o.verbose) {
          print(
            (e.level === "error" ? c.red : e.level === "warn" ? c.yellow : c.dim)(`  ${e.message}`),
          );
        }
        return;
      case "result":
        return;
      case "ended": {
        const out = e.outcome;
        const head = short(out.headNodeId);
        const label =
          out.reason === "done"
            ? c.green("done")
            : out.reason === "need_decision" || out.reason === "blocked"
              ? c.yellow(out.reason)
              : c.red(out.reason);
        print(
          `run ended (${label}) at ${c.bold(head)}  cost ${money(out.costUsd)}${out.numTurns ? `, ${out.numTurns} turns` : ""}`,
        );
        if (out.error) print(c.red(`  ${out.error}`));
        if (out.reason === "need_decision" || out.reason === "blocked") {
          print(`  answer with: ${c.bold(`turtle run --from ${head} "<your answer>"`)}`);
        } else if (out.reason === "done") {
          print(
            c.dim(
              `  inspect: turtle show ${head} --diff    export: turtle export ${head} --branch <name>`,
            ),
          );
        }
        return;
      }
    }
  };

  const session = await RunSession.start(
    {
      store,
      db,
      config,
      launcher: launcherFor(sandbox, config),
      summarizer: summarizerFor(config, (m) => print(c.yellow(`  ${m}`))),
      onEvent,
    },
    opts,
  );

  const pidFile = join(store.turtleDir, "run", `${session.agentId}.pid`);
  await mkdir(join(store.turtleDir, "run"), { recursive: true });
  await writeFile(pidFile, String(process.pid));
  const onSignal = () => session.interrupt();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const outcome = await session.done;
    return outcome.reason === "failed" ? 1 : outcome.reason === "killed" ? 130 : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(pidFile, { force: true });
  }
}
