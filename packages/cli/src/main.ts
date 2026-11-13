#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { auditCommand, gateCommand, shareCommand } from "./commands/gate.js";
import {
  answerCommand,
  checkCommand,
  goalCommand,
  graphCommand,
  lessonCommand,
  recipeCommand,
  type TaskStartOptions,
  taskAbandonCommand,
  taskAddCommand,
  taskDropCommand,
  taskPauseCommand,
  taskRetryCommand,
  taskShowCommand,
  taskStartCommand,
  tellCommand,
  undoCommand,
} from "./commands/graph.js";
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
  .command("goal")
  .description("add a goal: the root of a task graph")
  .argument("<text>", "what you want; the first line is the title")
  .action(async (text: string) => print(await goalCommand(cwd(), text, {})));

program
  .command("graph")
  .description("the task graph as a tree")
  .option("-g, --goal <goal>", "only this goal")
  .option("-a, --all", "include dropped concepts")
  .action(async (o: { goal?: string; all?: boolean }) => print(await graphCommand(cwd(), o)));

const task = program.command("task").description("tasks in the graph");
task
  .command("add")
  .description("add a task (under the latest goal unless --parent)")
  .argument("<title>")
  .option("-p, --parent <concept>", "goal or task to put it under")
  .option("--after <task...>", "tasks that must be done first")
  .option("--from <task>", "start from this task's latest checkpoint (reuse its work)")
  .option("-b, --body <text>", "details")
  .option("--no-agent", "a task for you, not for an agent")
  .action(
    async (
      title: string,
      o: { parent?: string; after?: string[]; from?: string; body?: string; agent?: boolean },
    ) => print(await taskAddCommand(cwd(), title, { ...o, noAgent: o.agent === false })),
  );
task
  .command("show")
  .description("a concept with its links and history")
  .argument("<concept>")
  .action(async (ref: string) => print(await taskShowCommand(cwd(), ref)));
task
  .command("drop")
  .description("drop a task or concept (undoable)")
  .argument("<concept>")
  .action(async (ref: string) => print(await taskDropCommand(cwd(), ref)));

task
  .command("start")
  .description("run the task's agent (continues its branch, or forks from its start point)")
  .argument("<task>")
  .option("-m, --message <text>", "an instruction for the agent")
  .option("--sandbox <mode>", "docker | none")
  .option("--model <model>", "model for the agent")
  .option("--budget <usd>", "maximum spend for this run in USD")
  .option("-v, --verbose", "also show micro snapshots and the agent's messages")
  .action(async (ref: string, o: TaskStartOptions) => {
    process.exitCode = await taskStartCommand(cwd(), ref, o);
  });
task
  .command("pause")
  .description("stop the task's agent at its next tool boundary; resume with task start")
  .argument("<task>")
  .action(async (ref: string) => print(await taskPauseCommand(cwd(), ref)));
program
  .command("tell")
  .description("tell a running task's agent something; it arrives at its next tool call")
  .argument("<task>")
  .argument("<text>")
  .action(async (ref: string, text: string) => print(await tellCommand(cwd(), ref, text)));
task
  .command("abandon")
  .description("give up an approach: keep its record, turn what it taught into a lesson")
  .argument("<task>")
  .option("-l, --lesson <text>", "the lesson (default: drafted from its findings)")
  .option("--on <node>", "node the lesson applies to (default: the task's parent)")
  .action(async (ref: string, o: { lesson?: string; on?: string }) =>
    print(await taskAbandonCommand(cwd(), ref, o)),
  );
task
  .command("retry")
  .description("try another way under <node>, from a checkpoint before the abandoned attempts")
  .argument("<node>")
  .argument("<title>")
  .option(
    "--from <checkpoint>",
    "checkpoint to start from (default: before the first abandoned attempt)",
  )
  .option("-b, --body <text>", "details")
  .action(async (ref: string, title: string, o: { from?: string; body?: string }) =>
    print(await taskRetryCommand(cwd(), ref, title, o)),
  );

program
  .command("lesson")
  .description("lessons: add | confirm | supersede")
  .argument("<action>", "add | confirm | supersede")
  .argument("<concept>", "the node to add to, or the lesson")
  .option("-t, --text <text>", "lesson text (add, or replace when confirming)")
  .action(async (action: string, ref: string, o: { text?: string }) => {
    if (action !== "add" && action !== "confirm" && action !== "supersede")
      throw new Error(`unknown action: ${action}`);
    print(await lessonCommand(cwd(), action, ref, o));
  });

program
  .command("check")
  .description("checks (hardened lessons): add | run | list | activate | retire")
  .argument("<action>", "add | run | list | activate | retire")
  .argument("<concept>", "add: the lesson, task or goal; run/list: the task; else the check")
  .option("-s, --script <file>", "add: the check script (.py, .sh, .js or .mjs)")
  .option("-t, --title <text>", "add: what the check verifies")
  .action(async (action: string, ref: string, o: { script?: string; title?: string }) => {
    if (!["add", "run", "list", "activate", "retire"].includes(action))
      throw new Error(`unknown action: ${action}`);
    print(await checkCommand(cwd(), action as "add", ref, o));
  });

const collect = (v: string, prev: string[] = []) => [...prev, v];
program
  .command("recipe")
  .description("recipes (redo a step without a model): add | verify | replay | list")
  .argument("<action>", "add | verify | replay | list")
  .argument("<concept>", "add/list: the task; verify/replay: the recipe")
  .option("-s, --script <file>", "add: the recipe script (.py, .sh, .js or .mjs)")
  .option("-t, --title <text>", "add: what it redoes; replay: the new task's title")
  .option("-p, --param <NAME=value>", "add: a parameter and its default; replay: a value", collect)
  .option("-o, --output <path>", "add: a file it regenerates (may use $" + "{NAME})", collect)
  .option("--tolerance <fraction>", "add: relative tolerance for numbers in CSV outputs")
  .action(
    async (
      action: string,
      ref: string,
      o: {
        script?: string;
        title?: string;
        param?: string[];
        output?: string[];
        tolerance?: string;
      },
    ) => {
      if (!["add", "verify", "replay", "list"].includes(action))
        throw new Error(`unknown action: ${action}`);
      print(await recipeCommand(cwd(), action as "add", ref, o));
    },
  );

program
  .command("answer")
  .description("answer a question; the answer is recorded as a decision")
  .argument("<question>")
  .argument("<text>")
  .action(async (ref: string, text: string) => print(await answerCommand(cwd(), ref, text)));

program
  .command("undo")
  .description("undo the batch of operations containing <op>")
  .argument("<op>", "operation id prefix (see turtle task show)")
  .action(async (op: string) => print(await undoCommand(cwd(), op)));

program
  .command("ui")
  .description("open the web UI: live tree, what needs you, diffs, and start/answer/fork/stop runs")
  .option("-p, --port <port>", `port on 127.0.0.1 (default ${DEFAULT_UI_PORT}; 0 = any free port)`)
  .option("--no-open", "do not open a browser")
  .option("--demo-agent", "scripted agents instead of Claude (no credentials needed)")
  .action(async (o: UiOptions) => {
    process.exitCode = await uiCommand(cwd(), o);
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
  .option("--gate", "evaluate the Phase 2 gate G1–G5 for the project")
  .option("--json", "with --gate: the report as JSON")
  .action(async (o: { criteria?: boolean; gate?: boolean; json?: boolean }) => {
    const { lines, ok } = o.gate
      ? await gateCommand(cwd(), o)
      : statsCommand(await openContext(cwd()), o);
    print(lines);
    if (!ok) process.exitCode = 1;
  });

program
  .command("share")
  .description(
    "write a task or goal as one self-contained HTML file (secrets and home paths redacted)",
  )
  .argument("<concept>", "the task or goal")
  .option("-o, --output <file>", "where to write it (default: <title>-<date>.html)")
  .option("--check", "scan for leftovers and ask a model the four questions from the file alone")
  .option(
    "--judge <yyyy>",
    "record your judgment for the gate: goal, results, decisions, open questions (y/n each)",
  )
  .option("--notes <text>", "with --judge: what was unclear")
  .action(
    async (ref: string, o: { output?: string; check?: boolean; judge?: string; notes?: string }) =>
      print(await shareCommand(cwd(), ref, o)),
  );

program
  .command("audit")
  .description(
    "audit finished tasks: does the record match the tool log? (gate G2, calls a small model)",
  )
  .option("--task <task...>", "only these tasks")
  .option("--force", "audit again even if the task did not change")
  .option("--model <id>", "model (default: the summarizer model)")
  .action(async (o: { task?: string[]; force?: boolean; model?: string }) =>
    print(await auditCommand(cwd(), o)),
  );

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
