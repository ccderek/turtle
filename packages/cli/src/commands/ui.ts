import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { HeuristicSummarizer } from "@turtle/core";
import { demoLauncher, startServer } from "@turtle/server";
import { CliError, type Context } from "../context.js";
import { c } from "../render.js";
import { credentialHint, launcherFor, summarizerFor } from "./run.js";

export const DEFAULT_UI_PORT = 4317;

export interface UiOptions {
  port?: string;
  open?: boolean;
  demoAgent?: boolean;
}

/** The built web client, or null when `pnpm build` has not produced it. */
export function webDistDir(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve("@turtle/web/package.json");
    const dist = join(dirname(pkg), "dist");
    return existsSync(join(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

/** `turtle ui`: serve the web UI until Ctrl-C (docs/phase1-spec.md §3). */
export async function uiCommand(ctx: Context, o: UiOptions): Promise<number> {
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const port = o.port === undefined ? DEFAULT_UI_PORT : Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new CliError(`invalid --port: ${o.port}`);
  const staticDir = webDistDir();
  if (!staticDir)
    print(c.yellow("web client not built: run `pnpm build` in the turtle repository"));

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      store: ctx.store,
      db: ctx.db,
      config: ctx.config,
      repoRoot: ctx.store.topLevel ?? ctx.cwd,
      launcherFor: o.demoAgent ? () => demoLauncher() : launcherFor,
      summarizer: o.demoAgent
        ? new HeuristicSummarizer()
        : summarizerFor(ctx.config, (m) => print(c.yellow(m))),
      staticDir,
      port,
      log: (line) => print(c.dim(`${new Date().toLocaleTimeString()} ${line}`)),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new CliError(
        `port ${port} is in use (is turtle ui already running?); try --port ${port + 1}`,
      );
    throw err;
  }

  print(
    `${c.bold("turtle ui")}  ${c.cyan(server.url)}  ${c.dim(`repo ${ctx.store.topLevel ?? ctx.cwd}`)}`,
  );
  if (o.demoAgent) print(c.yellow("demo agent: runs are scripted, no model is called"));
  else {
    const hint = credentialHint(ctx.config.sandbox.mode);
    if (hint) print(c.yellow(hint));
  }
  print(c.dim("keep this running while agents work; Ctrl-C stops it (and interrupts its runs)"));
  if (o.open !== false) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) process.exit(130);
      stopping = true;
      const n = server.sessions.size;
      print(n ? `stopping: interrupting ${n} run(s)… (Ctrl-C again to quit now)` : "stopping");
      void server.close().then(resolve);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
  return 0;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
