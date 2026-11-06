#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { logCommand, showCommand, statsCommand, statusCommand } from "./commands/inspect.js";
import {
  checkoutCommand,
  doctorCommand,
  exportCommand,
  gcCommand,
  initCommand,
  stopCommand,
  tagCommand,
} from "./commands/manage.js";
import {
  projectAddSourceCommand,
  projectCreateCommand,
  projectRebuildCommand,
  projectShowCommand,
} from "./commands/project.js";
import { type RunCliOptions, runCommand } from "./commands/run.js";
import { DEFAULT_UI_PORT, type UiOptions, uiCommand } from "./commands/ui.js";
import { CliError, openContext } from "./context.js";
import { c } from "./render.js";

const program = new Command();
program
  .name("turtle")
  .description("Record, inspect and steer AI coding agents as a tree of checkpoints")
  .version("0.1.0")
  .option("-C, --cwd <dir>", "run as if started in <dir>", process.cwd());

const cwd = () => resolve(program.opts<{ cwd: string }>().cwd);
const print = (lines: string[]) => {
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
};

program
  .command("init")
  .description("create turtle's state and a default turtle.config.json")
  .action(async () => print(await initCommand(await openContext(cwd()))));

program
  .command("run")
  .description("start an agent on a new branch, continue a branch head, or fork from any node")
  .argument("<prompt>", "what the agent should do (or your answer to its question)")
  .option(
    "--from <node>",
    "continue (branch head) or fork (any other node) from this node, snapshot or branch",
  )
  .option("--fork", "always create a new branch, even from a branch head")
  .option("--from-head", "start from HEAD, ignoring uncommitted changes")
  .option("--sandbox <mode>", "docker | none (default from config)")
  .option("--model <model>", "model for the agent")
  .option("--budget <usd>", "maximum spend for this run in USD")
  .option("--name <label>", "label for a new branch")
  .option("-v, --verbose", "also show micro snapshots and the agent's messages")
  .action(async (prompt: string, o: RunCliOptions) => {
    process.exitCode = await runCommand(await openContext(cwd()), prompt, o);
  });

const project = program
  .command("project")
  .description("turtle projects: the task graph above your repositories");
project
  .command("create")
  .description("create a project (its own git repository) and attach code repositories")
  .argument("<dir>")
  .option("-s, --source <repo...>", "code repositories to attach")
  .option("--name <name>", "project name (default: the directory name)")
  .action(async (dir: string, o: { source?: string[]; name?: string }) =>
    print(await projectCreateCommand(cwd(), dir, o)),
  );
project
  .command("add-source")
  .description("attach another code repository")
  .argument("<repo>")
  .option("--id <id>", "short name for the source")
  .action(async (repo: string, o: { id?: string }) =>
    print(await projectAddSourceCommand(cwd(), repo, o)),
  );
project
  .command("show")
  .description("the project, its sources and graph size")
  .action(async () => print(await projectShowCommand(cwd())));
project
  .command("rebuild")
  .description("rebuild the graph view from the operation log")
  .action(async () => print(await projectRebuildCommand(cwd())));

program
  .command("ui")
  .description("open the web UI: live tree, what needs you, diffs, and start/answer/fork/stop runs")
  .option("-p, --port <port>", `port on 127.0.0.1 (default ${DEFAULT_UI_PORT}; 0 = any free port)`)
  .option("--no-open", "do not open a browser")
  .option("--demo-agent", "scripted agents instead of Claude (no credentials needed)")
  .action(async (o: UiOptions) => {
    process.exitCode = await uiCommand(await openContext(cwd()), o);
  });

program
  .command("status")
  .description("running agents, checkpoints waiting for you, recent branches")
  .action(async () => print(statusCommand(await openContext(cwd()))));

program
  .command("log")
  .description("tree of checkpoints across branches")
  .option("-a, --all", "include micro snapshots")
  .option("-b, --branch <branch>", "only the history of this branch")
  .action(async (o: { all?: boolean; branch?: string }) =>
    print(logCommand(await openContext(cwd()), o)),
  );

program
  .command("show")
  .description("details of a node")
  .argument("<node>", "node id prefix, snapshot name or branch")
  .option("-d, --diff", "diff against the parent node")
  .option("-t, --transcript", "messages that led to this node")
  .option("--artifacts", "list artifacts")
  .action(async (ref: string, o: { diff?: boolean; transcript?: boolean; artifacts?: boolean }) =>
    print(await showCommand(await openContext(cwd()), ref, o)),
  );

program
  .command("checkout")
  .description("write a node's files into a directory for inspection")
  .argument("<node>")
  .argument("[dir]", "target directory (default ./turtle-<id>)")
  .action(async (ref: string, dir?: string) =>
    print(await checkoutCommand(await openContext(cwd()), ref, dir)),
  );

program
  .command("tag")
  .description("mark a node as a named snapshot (refs/turtle/snapshots/<name>)")
  .argument("<node>")
  .argument("<name>")
  .action(async (ref: string, name: string) =>
    print(await tagCommand(await openContext(cwd()), ref, name)),
  );

program
  .command("export")
  .description("create a normal git branch with one commit holding a node's files")
  .argument("<node>")
  .requiredOption("--branch <name>", "new git branch name")
  .option("-m, --message <text>", "commit title (default: the node's summary)")
  .action(async (ref: string, o: { branch: string; message?: string }) =>
    print(await exportCommand(await openContext(cwd()), ref, o)),
  );

program
  .command("stop")
  .description("interrupt the agent running on a branch")
  .argument("<branch>")
  .action(async (b: string) => print(await stopCommand(await openContext(cwd()), b)));

program
  .command("gc")
  .description("delete workspaces of finished branches (their content stays in git)")
  .option("--all", "also idle branches (waiting for an answer)")
  .option("-n, --dry-run", "only list what would be removed")
  .action(async (o: { all?: boolean; dryRun?: boolean }) =>
    print(await gcCommand(await openContext(cwd()), o)),
  );

program
  .command("doctor")
  .description("check that git refs, commits and the database agree")
  .action(async () => {
    const { lines, ok } = await doctorCommand(await openContext(cwd(), { reconcile: false }));
    print(lines);
    if (!ok) process.exitCode = 1;
  });

program
  .command("stats")
  .description("per-run metrics; --criteria checks the Phase 0 exit criteria")
  .option("--criteria", "evaluate exit criteria E1–E6")
  .action(async (o: { criteria?: boolean }) => {
    const { lines, ok } = statsCommand(await openContext(cwd()), o);
    print(lines);
    if (!ok) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`${c.red("error:")} ${err.message}\n`);
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(
      `${c.red("error:")} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  }
});
