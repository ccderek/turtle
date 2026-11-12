import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HookCallback, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createTransportPair,
  DEFAULT_CONFIG,
  GitStore,
  git,
  HeuristicSummarizer,
  mergeConfig,
  type RunnerLauncher,
  RunSession,
  TurtleDb,
} from "@turtle/core";
import type { FromRunner } from "@turtle/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeRunner, type RunnerDeps } from "../src/runner.js";

Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

// ---------------------------------------------------------------- mock SDK

interface ToolDef {
  name: string;
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: { text: string }[] }>;
}

/** What a scripted "model" can do inside the mocked query. */
interface MockCtx {
  options: Options;
  cwd: string;
  emit(msg: Record<string, unknown>): Promise<void>;
  /** Simulate one built-in tool call: tool_use message, effect, PostToolUse hook, tool_result. */
  tool(
    name: string,
    input: Record<string, unknown>,
    effect?: () => Promise<void>,
    failed?: boolean,
  ): Promise<void>;
  /** Simulate the model calling an MCP tool of the turtle server. */
  mcp(name: string, args: Record<string, unknown>): Promise<string>;
  interrupted(): boolean;
}

function mockSdk(script: (ctx: MockCtx) => Promise<void>) {
  const seen: { options?: Options; prompt?: string } = {};
  const sdk: RunnerDeps["sdk"] = {
    tool: ((name: string, _d: string, _s: unknown, handler: ToolDef["handler"]) => ({
      name,
      handler,
    })) as never,
    createSdkMcpServer: ((o: { tools: ToolDef[] }) => ({
      type: "sdk",
      name: "turtle",
      tools: o.tools,
    })) as never,
    query: (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      seen.options = options;
      const session = options.forkSession || !options.resume ? randomUUID() : options.resume;
      const queue: Record<string, unknown>[] = [];
      const waker: { fn: (() => void) | null } = { fn: null };
      let done = false;
      let interrupted = false;
      const push = async (m: Record<string, unknown>) => {
        queue.push({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...m });
        waker.fn?.();
        await new Promise((r) => setImmediate(r));
      };
      const hook = (event: "PostToolUse" | "PostToolUseFailure" | "Stop") =>
        options.hooks?.[event]?.[0]?.hooks[0] as HookCallback;
      const server = options.mcpServers?.turtle as unknown as { tools: ToolDef[] } | undefined;
      const tools = server?.tools ?? [];
      let n = 0;
      const ctx: MockCtx = {
        options,
        cwd: options.cwd ?? "",
        emit: push,
        async tool(name, input, effect, failed) {
          const id = `toolu_${++n}`;
          await push({
            type: "assistant",
            message: {
              id: `msg_${n}`,
              model: "claude-opus-5-5",
              content: [{ type: "tool_use", id, name, input }],
              usage: { input_tokens: 50, output_tokens: 5 },
            },
          });
          await effect?.();
          const base = {
            session_id: session,
            transcript_path: "",
            cwd: ctx.cwd,
            tool_name: name,
            tool_input: input,
            tool_use_id: id,
          };
          if (failed) {
            await hook("PostToolUseFailure")(
              { ...base, hook_event_name: "PostToolUseFailure", error: "Exit code 1" },
              id,
              { signal: new AbortController().signal },
            );
          } else {
            await hook("PostToolUse")(
              {
                ...base,
                hook_event_name: "PostToolUse",
                tool_response: { stdout: "", stderr: "", interrupted: false },
              },
              id,
              { signal: new AbortController().signal },
            );
          }
          await push({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
            },
          });
        },
        async mcp(name, args) {
          const id = `toolu_${++n}`;
          await push({
            type: "assistant",
            message: {
              id: `msg_${n}`,
              model: "claude-opus-5-5",
              content: [{ type: "tool_use", id, name: `mcp__turtle__${name}`, input: args }],
              usage: { input_tokens: 50, output_tokens: 5 },
            },
          });
          const def = tools.find((t) => t.name === name);
          const res = await def?.handler(args, {});
          const text = res?.content[0]?.text ?? "";
          await hook("PostToolUse")(
            {
              session_id: session,
              transcript_path: "",
              cwd: ctx.cwd,
              hook_event_name: "PostToolUse",
              tool_name: `mcp__turtle__${name}`,
              tool_input: args,
              tool_response: text,
              tool_use_id: id,
            },
            id,
            { signal: new AbortController().signal },
          );
          await push({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: id, content: text }],
            },
          });
          return text;
        },
        interrupted: () => interrupted,
      };

      const driver = (async () => {
        const it = prompt[Symbol.asyncIterator]();
        const first = await it.next();
        seen.prompt = String((first.value as SDKUserMessage).message.content);
        await push({
          type: "system",
          subtype: "init",
          model: "claude-opus-5-5",
          cwd: ctx.cwd,
          tools: [],
        });
        await script(ctx);
        if (!interrupted) {
          await (hook("Stop") as HookCallback)(
            {
              session_id: session,
              transcript_path: "",
              cwd: ctx.cwd,
              hook_event_name: "Stop",
              stop_hook_active: false,
              last_assistant_message: "done",
            },
            undefined,
            { signal: new AbortController().signal },
          );
        }
        await push({
          type: "result",
          subtype: interrupted ? "error_during_execution" : "success",
          is_error: interrupted,
          num_turns: n,
          total_cost_usd: 0.05,
        });
        await it.next(); // wait until the runner closes the input
        done = true;
        waker.fn?.();
      })();

      const gen = (async function* () {
        while (true) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          if (done) break;
          await new Promise<void>((r) => {
            waker.fn = r;
          });
          waker.fn = null;
        }
        await driver;
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          interrupted = true;
        },
        close: () => {},
      });
    }) as never,
  };
  return { sdk, seen };
}

// ------------------------------------------------------------- harness

async function setup() {
  const repo = (await import("node:fs/promises")).mkdtemp(
    join((await import("node:os")).tmpdir(), "turtle-rc-"),
  );
  const dir = await repo;
  await git(["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "app.ts"), "export const a = 1;\n");
  await git(["add", "-A"], { cwd: dir });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
  const store = await GitStore.open(dir);
  const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
    sandbox: { mode: "none" },
    tests: { command: "npm test" },
  });
  return { dir, store, db, config };
}

function claudeLauncher(sdk: RunnerDeps["sdk"]): RunnerLauncher {
  return async (spec) => {
    const { orchestrator, runner } = createTransportPair();
    const claude = new ClaudeRunner({
      cwd: spec.workspace,
      sdk,
      send: (m: FromRunner) => runner.send(m),
      exit: (code) => setImmediate(() => runner.close(code)),
      exec: async (cmd) => ({ exitCode: cmd === "fail-setup" ? 3 : 0, stdout: "", stderr: "boom" }),
    });
    runner.onMessage((m) => claude.handle(m));
    setImmediate(() => claude.ready());
    return orchestrator;
  };
}

async function runWith(
  script: (ctx: MockCtx) => Promise<void>,
  opts: { prompt?: string; setup?: string } = {},
) {
  const env = await setup();
  if (opts.setup) env.config.workspace.setupCommand = opts.setup;
  const { sdk, seen } = mockSdk(script);
  const session = await RunSession.start(
    {
      store: env.store,
      db: env.db,
      config: env.config,
      summarizer: new HeuristicSummarizer(),
      workspaceRoot: join(env.dir, "..", `${env.dir.split("/").pop()}-ws`),
      launcher: claudeLauncher(sdk),
    },
    { prompt: opts.prompt ?? "Do the thing" },
  );
  return { ...env, session, seen, outcome: await session.done };
}

// ------------------------------------------------------------------- tests

describe("ClaudeRunner with a mocked SDK", () => {
  it("passes options, forwards messages, and drives checkpoints end to end", async () => {
    const { db, session, seen, outcome } = await runWith(async (ctx) => {
      await ctx.tool("Write", { file_path: "new.ts" }, async () => {
        await writeFile(join(ctx.cwd, "new.ts"), "export const n = 1;\n");
      });
      await ctx.tool("Bash", { command: "npm test" }, undefined, true);
      const reply = await ctx.mcp("checkpoint", {
        summary: "Add new.ts\n\nFirst step.",
        status: "need_decision",
      });
      expect(reply).toMatch(/^Checkpoint \w+ recorded\. End your turn now/);
      expect(await ctx.mcp("history", {})).toContain("[need_decision] Add new.ts");
      expect(await ctx.mcp("diff", { since: "branch_start" })).toContain("+export const n = 1;");
    });

    expect(seen.prompt).toBe("Do the thing");
    expect(seen.options).toMatchObject({
      cwd: session.workspace,
      permissionMode: "acceptEdits",
      model: "claude-opus-5-5",
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect((seen.options?.systemPrompt as { append?: string } | undefined)?.append).toContain(
      "mcp__turtle__checkpoint",
    );
    expect(seen.options?.allowDangerouslySkipPermissions).toBeUndefined();

    expect(outcome.reason).toBe("need_decision");
    const nodes = db.listNodes({ branchId: session.branchId });
    expect(nodes.map((n) => `${n.kind}:${n.trigger}`)).toEqual([
      "root:root",
      "micro:tool:Write",
      "semantic:declared",
    ]);
    const declared = nodes.at(-1);
    expect(declared).toMatchObject({
      summary: "Add new.ts\n\nFirst step.",
      status: "need_decision",
      tests: "fail",
    });
    // The checkpoint's resume point is the tool_result message of its own tool call.
    const resultMsg = db
      .listMessages(session.agentId)
      .find(
        (m) => m.type === "user" && m.json.includes(`"tool_use_id":"${declared?.resumeToolUseId}"`),
      );
    expect(declared?.resumeToolUseId).toBe("toolu_3");
    expect(declared?.resumeMessageUuid).toBe(resultMsg?.uuid);
    expect(db.getAgent(session.agentId)).toMatchObject({ status: "done", totalCostUsd: 0.05 });
  });

  it("fails the run when the setup command fails", async () => {
    const { outcome } = await runWith(async () => {}, { setup: "fail-setup" });
    expect(outcome.reason).toBe("failed");
    expect(outcome.error).toMatch(/setup command failed \(exit 3\)/);
  });

  it("interrupts the query and records a killed checkpoint", async () => {
    let sessionRef: RunSession | undefined;
    const env = await setup();
    const { sdk } = mockSdk(async (ctx) => {
      await ctx.tool("Write", { file_path: "a.ts" }, async () => {
        await mkdir(ctx.cwd, { recursive: true });
        await writeFile(join(ctx.cwd, "a.ts"), "a\n");
      });
      sessionRef?.interrupt();
      while (!ctx.interrupted()) await new Promise((r) => setTimeout(r, 5));
    });
    const session = await RunSession.start(
      {
        store: env.store,
        db: env.db,
        config: env.config,
        summarizer: new HeuristicSummarizer(),
        workspaceRoot: join(env.dir, "..", `${env.dir.split("/").pop()}-ws`),
        launcher: claudeLauncher(sdk),
      },
      { prompt: "long" },
    );
    sessionRef = session;
    const outcome = await session.done;
    expect(outcome.reason).toBe("killed");
    expect(env.db.listNodes({ branchId: session.branchId }).at(-1)).toMatchObject({
      kind: "semantic",
      status: "killed",
    });
  });

  it("maps fork options and bypass permissions onto SDK options", () => {
    const { sdk } = mockSdk(async () => {});
    const runner = new ClaudeRunner({ cwd: "/w", sdk, send: () => {}, exit: () => {} });
    const opts = runner.options({
      systemPromptAppend: "x",
      permissionMode: "bypassPermissions",
      resume: "s1",
      resumeSessionAt: "u1",
      forkSession: true,
      maxTurns: 5,
      maxBudgetUsd: 2,
    });
    expect(opts).toMatchObject({
      cwd: "/w",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      resume: "s1",
      resumeSessionAt: "u1",
      forkSession: true,
      maxTurns: 5,
      maxBudgetUsd: 2,
    });
    expect(Object.keys(opts.hooks ?? {})).toEqual(["PostToolUse", "PostToolUseFailure", "Stop"]);
  });

  it("exposes the task-graph tools only for task runs and forwards them as graph requests", async () => {
    const { sdk } = mockSdk(async () => {});
    const sent: FromRunner[] = [];
    const runner = new ClaudeRunner({ cwd: "/w", sdk, send: (m) => sent.push(m), exit: () => {} });
    const names = (o: Options) =>
      ((o.mcpServers?.turtle ?? { tools: [] }) as unknown as { tools: ToolDef[] }).tools.map(
        (t) => t.name,
      );
    expect(
      names(runner.options({ systemPromptAppend: "x", permissionMode: "acceptEdits" })),
    ).toEqual(["checkpoint", "diff", "history"]);
    const opts = runner.options({
      systemPromptAppend: "x",
      permissionMode: "acceptEdits",
      graphTools: true,
    });
    expect(names(opts)).toEqual([
      "checkpoint",
      "diff",
      "task",
      "finding",
      "decision",
      "question",
      "brief",
      "lesson",
      "check",
      "recipe",
      "graph",
      "history",
    ]);
    const graph = (
      (opts.mcpServers?.turtle ?? { tools: [] }) as unknown as { tools: ToolDef[] }
    ).tools.find((t) => t.name === "graph");
    const pending = graph?.handler({ scope: "goal" }, {});
    const req = sent.find((m) => m.t === "request");
    expect(req).toMatchObject({ kind: "graph", op: "read", args: { scope: "goal" } });
    runner.handle({
      t: "reply",
      id: (req as { id: number }).id,
      ok: true,
      result: { message: "Goal: G" },
    });
    expect((await pending)?.content[0]?.text).toBe("Goal: G");
  });
});

describe("ensureSessionInProject", () => {
  it("copies a session transcript from another project dir once", async () => {
    const { ensureSessionInProject, projectDirName } = await import("../src/runner.js");
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const config = await mkdtemp(join(tmpdir(), "turtle-cc-"));
    const src = join(config, "projects", projectDirName("/ws/old"));
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "s1.jsonl"), '{"x":1}\n');
    expect(projectDirName("/ws/new_1")).toBe("-ws-new-1");
    expect(await ensureSessionInProject(config, "s1", "/ws/new_1")).toBe(true);
    expect(await readFile(join(config, "projects", "-ws-new-1", "s1.jsonl"), "utf8")).toBe(
      '{"x":1}\n',
    );
    expect(await ensureSessionInProject(config, "s1", "/ws/new_1")).toBe(false);
    expect(await ensureSessionInProject(config, "missing", "/ws/new_1")).toBe(false);
  });
});
