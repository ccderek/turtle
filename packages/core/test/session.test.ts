import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, type TurtleConfig } from "../src/config.js";
import { TurtleDb } from "../src/db/db.js";
import { reconcile } from "../src/db/reconcile.js";
import { git } from "../src/git/exec.js";
import { GitStore } from "../src/git/store.js";
import { type RunEvent, type RunOptions, RunSession } from "../src/run/session.js";
import { HeuristicSummarizer } from "../src/run/summarizer.js";
import {
  type FakeAgent,
  type FakeLauncherOptions,
  type FakeScript,
  fakeLauncher,
} from "../src/testing/fake-runner.js";
import { makeRepo, tempDir } from "./helpers.js";

interface Env {
  repo: string;
  store: GitStore;
  db: TurtleDb;
  workspaceRoot: string;
  config: TurtleConfig;
}

async function env(configOverride: unknown = {}): Promise<Env> {
  const repo = await makeRepo({
    "src/app.ts": "export const app = 1;\n",
    ".gitignore": "node_modules/\n",
  });
  const store = await GitStore.open(repo);
  const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), {
    sandbox: { mode: "none" },
    ...(configOverride as object),
  });
  return { repo, store, db, workspaceRoot: await tempDir("turtle-wsroot-"), config };
}

async function run(
  e: Env,
  script: FakeScript,
  opts: Partial<RunOptions> = {},
  launcherOpts: FakeLauncherOptions = {},
) {
  const events: RunEvent[] = [];
  let agent: FakeAgent | undefined;
  const session = await RunSession.start(
    {
      store: e.store,
      db: e.db,
      config: e.config,
      summarizer: new HeuristicSummarizer(),
      workspaceRoot: e.workspaceRoot,
      launcher: fakeLauncher(script, {
        ...launcherOpts,
        onAgent: (a) => {
          agent = a;
        },
      }),
      onEvent: (ev) => events.push(ev),
    },
    { prompt: "Add a --json flag", ...opts },
  );
  const outcome = await session.done;
  return { session, outcome, events, agent: agent as FakeAgent };
}

const kinds = (db: TurtleDb, branchId: string) =>
  db.listNodes({ branchId }).map((n) => `${n.kind}:${n.trigger}`);

describe("RunSession: new branch", () => {
  it("records micro snapshots, declared and closing checkpoints", async () => {
    const e = await env();
    await writeDirty(e.repo);
    const { session, outcome, events } = await run(e, async (a) => {
      await a.say("Looking at the code.");
      await a.tool("Read", { file_path: "src/app.ts" });
      await a.edit("src/app.ts", "export const app = 2;\n");
      await a.edit("src/json.ts", "export const json = true;\n");
      await a.checkpoint("Add --json option parsing\n\nParses the flag.");
      await a.edit("README.md", "docs\n");
      await a.finish("All done.");
    });

    expect(outcome.reason).toBe("done");
    expect(kinds(e.db, session.branchId)).toEqual([
      "root:root",
      "micro:tool:Edit",
      "micro:tool:Edit",
      "semantic:declared",
      "micro:tool:Edit",
      "semantic:stop",
    ]);
    const nodes = e.db.listNodes({ branchId: session.branchId });
    const [root, , , declared, , closing] = nodes;
    expect(root?.summary).toMatch(/^root: HEAD [0-9a-f]{7} \+ uncommitted changes$/);
    expect(declared).toMatchObject({
      summary: "Add --json option parsing\n\nParses the flag.",
      summarySource: "agent_declared",
      status: "progress",
      filesChanged: 2, // since the root: src/app.ts and src/json.ts
      linesAdded: 2,
      linesDeleted: 1,
      intent: "Add a --json flag",
    });
    expect(closing).toMatchObject({ summarySource: "rule_auto", status: "done" });
    expect(closing?.summary).toContain("README.md");

    // git and DB agree; branch ref points at the last node.
    const branch = e.db.getBranch(session.branchId);
    expect(branch?.status).toBe("done");
    expect(branch?.headNodeId).toBe(closing?.id);
    expect(await e.store.readRef(branch?.ref ?? "")).toBe(closing?.commitSha);
    expect((await reconcile(e.store, e.db)).importedNodes).toEqual([]);

    // The workspace is a plain directory holding the agent's work and the dirty root state.
    expect(existsSync(join(session.workspace, ".git"))).toBe(false);
    expect(await readFile(join(session.workspace, "src/app.ts"), "utf8")).toBe(
      "export const app = 2;\n",
    );
    expect(await readFile(join(session.workspace, "notes.txt"), "utf8")).toBe("uncommitted\n");

    // Agent bookkeeping.
    const agent = e.db.getAgent(session.agentId);
    expect(agent).toMatchObject({ status: "done", adapterLevel: 2 });
    expect(agent?.sessionId).toBeTruthy();
    expect(agent?.totalCostUsd).toBeGreaterThan(0);
    expect(events.map((ev) => ev.type)).toContain("started");
    expect(events.at(-1)?.type).toBe("ended");

    // The user's repository is untouched.
    expect(await git(["status", "--porcelain"], { cwd: e.repo })).toBe("?? notes.txt");
  });

  it("does not snapshot read-only tools or unchanged edits", async () => {
    const e = await env();
    const { session } = await run(e, async (a) => {
      await a.tool("Grep", { pattern: "app" });
      await a.tool("Bash", { command: "ls" }); // mutating tool, but nothing changed
      await a.edit("src/app.ts", "export const app = 1;\n"); // same content
      await a.checkpoint("Nothing to change", "done");
      await a.finish();
    });
    expect(kinds(e.db, session.branchId)).toEqual(["root:root", "semantic:declared"]);
  });

  it("records resume points after the tool_result and attributes tokens and messages", async () => {
    const e = await env();
    const { session, agent } = await run(e, async (a) => {
      await a.edit("a.txt", "a\n");
      await a.checkpoint("Add a");
      await a.finish();
    });
    const [, micro, declared] = e.db.listNodes({ branchId: session.branchId });
    const messages = e.db.listMessages(session.agentId);
    const resultOf = (toolUseId: string | null) =>
      messages.find((m) => m.type === "user" && m.json.includes(`"tool_use_id":"${toolUseId}"`))
        ?.uuid;
    expect(micro?.resumeMessageUuid).toBe(resultOf(micro?.resumeToolUseId ?? null));
    expect(declared?.resumeMessageUuid).toBe(resultOf(declared?.resumeToolUseId ?? null));
    expect(declared?.sessionId).toBe(agent.sessionId);
    // 100 input / 20 output tokens per assistant message (edit tool_use, checkpoint tool_use).
    expect(micro?.tokens).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(micro?.costUsdEst).toBeCloseTo((100 * 4 + 20 * 20) / 1e6);
    expect(e.db.listMessages(session.agentId, { nodeId: micro?.id }).length).toBeGreaterThan(0);
  });

  it("starts from HEAD with fromHead", async () => {
    const e = await env();
    await writeDirty(e.repo);
    const { session } = await run(e, async (a) => a.finish(), { fromHead: true });
    expect(existsSync(join(session.workspace, "notes.txt"))).toBe(false);
    const root = e.db.getNode(e.db.getBranch(session.branchId)?.rootNodeId ?? "");
    expect(root?.summary).not.toContain("uncommitted");
  });

  it("answers diff and history requests", async () => {
    const e = await env();
    let diffText = "";
    let history: { summary: string }[] = [];
    await run(e, async (a) => {
      await a.edit("src/app.ts", "export const app = 3;\n");
      await a.checkpoint("Bump app to 3");
      await a.edit("b.txt", "b\n");
      diffText = (await a.diff("last_checkpoint")).diff;
      history = await a.history();
      await a.finish();
    });
    expect(diffText).toContain("+b");
    expect(diffText).not.toContain("app = 3");
    expect(history.map((h) => h.summary)).toEqual(["Bump app to 3"]);
  });

  it("stores artifacts inside the workspace and ignores paths outside it", async () => {
    const e = await env();
    let nodeId = "";
    await run(e, async (a) => {
      await a.writeFile("out/report.txt", "report\n");
      nodeId = (
        await a.checkpoint("Report", "progress", [
          { path: "out/report.txt", label: "report" },
          { path: "../../etc/passwd" },
        ])
      ).nodeId;
      await a.finish();
    });
    const arts = e.db.listArtifacts(nodeId);
    expect(arts).toMatchObject([{ label: "report", path: "out/report.txt", size: 7 }]);
    expect((await e.store.readBlob(arts[0]?.blobSha ?? "")).toString()).toBe("report\n");
  });
});

describe("RunSession: rules", () => {
  it("adds an auto checkpoint after maxToolCalls", async () => {
    const e = await env({ checkpoint: { rules: { maxToolCalls: 3 } } });
    const { session } = await run(e, async (a) => {
      await a.edit("1.txt", "1\n");
      await a.tool("Read", { file_path: "1.txt" });
      await a.edit("2.txt", "2\n"); // third tool call → rule fires
      await a.checkpoint("Agent summary");
      await a.finish();
    });
    expect(kinds(e.db, session.branchId)).toEqual([
      "root:root",
      "micro:tool:Edit",
      "micro:tool:Edit",
      "semantic:rule:maxToolCalls",
      "semantic:declared",
    ]);
    const auto = e.db.listNodes({ branchId: session.branchId, kinds: ["semantic"] })[0];
    expect(auto).toMatchObject({ summarySource: "rule_auto", status: "progress" });
    expect(auto?.summary).toContain("Change 1.txt, 2.txt (+2 −0)");
  });

  it("adds an auto checkpoint when tests flip", async () => {
    const e = await env({ tests: { command: "npm test" } });
    const { session, events } = await run(e, async (a) => {
      await a.tool(
        "Bash",
        { command: "npm test" },
        { response: "Exit code 1\n1 failed", failed: true },
      );
      await a.checkpoint("Reproduce the bug");
      await a.edit("fix.txt", "fix\n");
      await a.tool(
        "Bash",
        { command: "npm test -- --run" },
        { response: { stdout: "3 passed", stderr: "", interrupted: false } },
      );
      await a.finish("Fixed.");
    });
    const semantic = e.db.listNodes({ branchId: session.branchId, kinds: ["semantic"] });
    expect(semantic.map((n) => `${n.trigger}:${n.tests}`)).toEqual([
      "declared:fail",
      "rule:testFlip:pass",
    ]);
    expect(
      events.filter((ev) => ev.type === "tests").map((ev) => (ev as { status: string }).status),
    ).toEqual(["fail", "pass"]);
  });

  it("runs the test command at checkpoints when configured", async () => {
    const e = await env({ tests: { command: "npm test", runAtCheckpoint: true } });
    const { session } = await run(
      e,
      async (a) => {
        await a.checkpoint("Check");
        await a.finish();
      },
      {},
      { exec: (cmd) => (cmd === "npm test" ? 1 : 0) },
    );
    expect(e.db.listNodes({ branchId: session.branchId, kinds: ["semantic"] })[0]?.tests).toBe(
      "fail",
    );
  });
});

describe("RunSession: continue and fork", () => {
  it("ends on need_decision and continues the same branch and session", async () => {
    const e = await env();
    const first = await run(e, async (a) => {
      await a.edit("q.txt", "draft\n");
      await a.checkpoint("Should --json include nested objects?", "need_decision");
      await a.finish("Should --json include nested objects?");
    });
    expect(first.outcome.reason).toBe("need_decision");
    expect(e.db.getBranch(first.session.branchId)?.status).toBe("idle");
    expect(kinds(e.db, first.session.branchId).at(-1)).toBe("semantic:declared");

    const head = e.db.getBranch(first.session.branchId)?.headNodeId ?? "";
    const second = await run(
      e,
      async (a) => {
        await a.edit("q.txt", "final\n");
        await a.finish("Done.");
      },
      { from: head, prompt: "Yes, include nested objects" },
    );
    expect(second.session.mode).toBe("continue");
    expect(second.session.branchId).toBe(first.session.branchId);
    expect(second.session.workspace).toBe(first.session.workspace);
    expect(second.agent.options.resume).toBe(first.agent.sessionId);
    expect(second.agent.options.resumeSessionAt).toBeUndefined();
    expect(second.agent.prompt).toBe("Yes, include nested objects");
    expect(second.outcome.reason).toBe("done");
    const nodes = e.db.listNodes({ branchId: first.session.branchId });
    expect(nodes.at(-2)?.parents).toEqual([head]);
  });

  it("forks from a mid-run node into a new branch and resumes at that point", async () => {
    const e = await env();
    const first = await run(e, async (a) => {
      await a.edit("one.txt", "1\n");
      await a.checkpoint("Step one");
      await a.edit("two.txt", "2\n");
      await a.checkpoint("Step two", "done");
      await a.finish();
    });
    const stepOne = e.db.listNodes({ branchId: first.session.branchId, kinds: ["semantic"] })[0];
    expect(stepOne?.resumeMessageUuid).toBeTruthy();

    const fork = await run(
      e,
      async (a) => {
        await a.edit("three.txt", "3\n");
        await a.finish();
      },
      { from: stepOne?.id ?? "", prompt: "Try another way" },
    );
    expect(fork.session.mode).toBe("fork");
    expect(fork.session.branchId).not.toBe(first.session.branchId);
    expect(fork.agent.options).toMatchObject({
      resume: first.agent.sessionId,
      resumeSessionAt: stepOne?.resumeMessageUuid,
      forkSession: true,
    });
    expect(fork.agent.prompt).toMatch(
      /^\[turtle\] This conversation was forked into a new working directory: .+\n\nTry another way$/,
    );
    expect(existsSync(join(fork.session.workspace, "one.txt"))).toBe(true);
    expect(existsSync(join(fork.session.workspace, "two.txt"))).toBe(false);
    const forkBranch = e.db.getBranch(fork.session.branchId);
    expect(forkBranch).toMatchObject({ forkedFromNodeId: stepOne?.id, rootNodeId: stepOne?.id });
    const forkNodes = e.db.listNodes({ branchId: fork.session.branchId });
    expect(forkNodes[0]?.parents).toEqual([stepOne?.id]);
    expect(
      e.db
        .childrenOf(stepOne?.id ?? "")
        .map((n) => n.branchId)
        .sort(),
    ).toEqual([first.session.branchId, fork.session.branchId].sort());
    // The original branch is unchanged.
    expect(e.db.getBranch(first.session.branchId)?.status).toBe("done");
  });

  it("forks from a head with --fork, and from root without a session", async () => {
    const e = await env();
    const first = await run(e, async (a) => {
      await a.edit("x.txt", "x\n");
      await a.finish();
    });
    const branch = e.db.getBranch(first.session.branchId);
    const fromHead = await run(e, async (a) => a.finish(), {
      from: branch?.headNodeId ?? "",
      fork: true,
    });
    expect(fromHead.session.mode).toBe("fork");

    const fromRoot = await run(e, async (a) => a.finish(), { from: branch?.rootNodeId ?? "" });
    expect(fromRoot.session.mode).toBe("fork");
    expect(fromRoot.agent.options.resume).toBeUndefined();
    expect(fromRoot.agent.prompt).toBe("Add a --json flag");
  });

  it("adds earlier summaries to the prompt when no resume point exists", async () => {
    const e = await env();
    const first = await run(e, async (a) => {
      await a.edit("x.txt", "x\n");
      await a.finish("Wrote x.");
    });
    const closing = e.db.getBranch(first.session.branchId)?.headNodeId ?? "";
    const fork = await run(e, async (a) => a.finish(), {
      from: closing,
      fork: true,
      prompt: "Next",
    });
    expect(fork.agent.options.resume).toBeUndefined();
    expect(fork.agent.prompt).toMatch(
      /^Earlier work on this branch \(newest first\):\n- \[done\] .+\n\nNext$/,
    );
  });

  it("refuses to continue a running branch without --fork", async () => {
    const e = await env();
    const first = await run(e, async (a) => {
      await a.finish();
    });
    const branchId = first.session.branchId;
    e.db.updateBranch(branchId, { status: "running" });
    const head = e.db.getBranch(branchId)?.headNodeId ?? "";
    await expect(
      run(
        e,
        async (a) => {
          await a.finish();
        },
        { from: head },
      ),
    ).rejects.toThrow(/running/);
  });
});

describe("RunSession: interrupt and crash", () => {
  it("interrupt leaves a killed checkpoint with the latest changes", async () => {
    const e = await env();
    let sessionRef: RunSession | undefined;
    const events: RunEvent[] = [];
    const session = await RunSession.start(
      {
        store: e.store,
        db: e.db,
        config: e.config,
        summarizer: new HeuristicSummarizer(),
        workspaceRoot: e.workspaceRoot,
        onEvent: (ev) => events.push(ev),
        launcher: fakeLauncher(async (a) => {
          await a.edit("wip.txt", "wip\n");
          await a.writeFile("unsaved.txt", "not yet snapshotted\n");
          setImmediate(() => sessionRef?.interrupt());
          await a.waitForInterrupt();
          await a.edit("never.txt", "x\n"); // throws: interrupted
        }),
      },
      { prompt: "long task" },
    );
    sessionRef = session;
    const outcome = await session.done;
    expect(outcome.reason).toBe("killed");
    const nodes = e.db.listNodes({ branchId: session.branchId });
    expect(nodes.map((n) => `${n.kind}:${n.trigger}`)).toEqual([
      "root:root",
      "micro:tool:Edit",
      "micro:interrupt",
      "semantic:interrupt",
    ]);
    expect(nodes.at(-1)?.status).toBe("killed");
    expect(e.db.getAgent(session.agentId)?.status).toBe("killed");
    expect(e.db.getBranch(session.branchId)?.status).toBe("killed");
    expect((await reconcile(e.store, e.db)).importedNodes).toEqual([]);
  });

  it("a crashed runner fails the run but keeps its changes", async () => {
    const e = await env();
    const { session, outcome } = await run(
      e,
      async (a) => {
        await a.writeFile("partial.txt", "partial\n");
      },
      {},
      { crash: true },
    );
    expect(outcome.reason).toBe("failed");
    expect(outcome.error).toBeTruthy();
    const last = e.db.listNodes({ branchId: session.branchId }).at(-1);
    expect(last).toMatchObject({ kind: "semantic", status: "failed", trigger: "crash" });
    expect(e.db.getAgent(session.agentId)?.status).toBe("failed");
    expect(await e.store.run(["show", `${last?.commitSha}:partial.txt`])).toBe("partial");
  });

  it("subagent tool calls get no resume point", async () => {
    const e = await env();
    const { session } = await run(e, async (a) => {
      await a.tool(
        "Write",
        { file_path: "sub.txt" },
        { effect: () => a.writeFile("sub.txt", "s\n"), agentId: "sub1" },
      );
      await a.finish();
    });
    const micro = e.db.listNodes({ branchId: session.branchId, kinds: ["micro"] })[0];
    expect(micro?.resumeToolUseId).toBeNull();
  });
});

async function writeDirty(repo: string) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(repo, "notes.txt"), "uncommitted\n");
}

describe("detectTestResult", () => {
  it("reads failed calls, explicit codes and output", async () => {
    const { detectTestResult } = await import("../src/run/rules.js");
    const bash = (command: string) => ({ command });
    expect(detectTestResult("npm test", "Bash", bash("ls"), "")).toBeNull();
    expect(detectTestResult(undefined, "Bash", bash("npm test"), "")).toBeNull();
    expect(detectTestResult("npm test", "Bash", bash("npm test"), "Error", true)).toBe("fail");
    expect(detectTestResult("npm test", "Bash", bash("npm test"), { exitCode: 2 })).toBe("fail");
    expect(
      detectTestResult("npm test", "Bash", bash("npm test"), { stdout: "Tests: 1 failed" }),
    ).toBe("fail");
    expect(
      detectTestResult("npm test", "Bash", bash("npm test"), { stdout: "ok", interrupted: true }),
    ).toBeNull();
    expect(
      detectTestResult("npm test", "Bash", bash("npm test -- x"), { stdout: "all good" }),
    ).toBe("pass");
  });
});

describe("dockerRunArgs", () => {
  it("mounts the workspace and config dir, runs as the host user and passes credentials by name", async () => {
    const { dockerRunArgs } = await import("../src/run/docker.js");
    const args = dockerRunArgs(
      { image: "img:1", extraArgs: ["--network", "host"], forwardEnv: ["MY_TOKEN"] },
      {
        agentId: "a1",
        workspace: "/ws/b1",
        claudeConfigDir: "/repo/.git/turtle/claude",
        env: { X: "1" },
      },
      {
        uid: 501,
        gid: 20,
        env: { ANTHROPIC_API_KEY: "secret", MY_TOKEN: "t", NODE_EXTRA_CA_CERTS: "/ca.pem" },
      },
    );
    const joined = args.join(" ");
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "-i", "--name", "turtle-a1"]);
    expect(joined).toContain("--user 501:20");
    expect(joined).toContain("-v /ws/b1:/workspace");
    expect(joined).toContain("-v /repo/.git/turtle/claude:/turtle/claude");
    expect(joined).toContain("-e ANTHROPIC_API_KEY -e MY_TOKEN");
    expect(joined).not.toContain("secret");
    expect(joined).toContain("-v /ca.pem:/turtle/ca.crt:ro -e NODE_EXTRA_CA_CERTS=/turtle/ca.crt");
    expect(args.slice(-4)).toEqual(["--network", "host", "img:1", "turtle-runner"]);
    expect(joined).not.toContain(".git:");
  });
});
