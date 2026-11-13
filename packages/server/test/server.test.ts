import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type FakeAgent,
  type FakeScript,
  fakeLauncher,
  GitStore,
  git,
  HeuristicSummarizer,
  mergeConfig,
  Project,
  requestStop,
  TurtleDb,
} from "@turtle/core";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CheckRunResponse,
  Concept,
  ConceptDetailResponse,
  DiffResponse,
  ExportSummaryResponse,
  GateResponse,
  GraphResponse,
  NodeDetailResponse,
  OutputContentResponse,
  RunResponse,
  StateResponse,
  TranscriptResponse,
} from "../src/api.js";
import { startServer, type TurtleServer } from "../src/server.js";

Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

let current: TurtleServer | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

/** Scripts are picked per run from a queue the test fills. */
async function setup(opts: { failLaunch?: boolean; project?: boolean; autoStart?: boolean } = {}) {
  const repo = await mkdtemp(join(tmpdir(), "turtle-srv-"));
  await git(["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], {
    cwd: repo,
  });
  const store = await GitStore.open(repo);
  const dbPath = join(store.turtleDir, "turtle.db");
  const db = TurtleDb.open(dbPath);
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), { sandbox: { mode: "none" } });
  const staticDir = join(repo, "..", `${repo.split("/").at(-1)}-web`);
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>turtle</title>");
  const scripts: FakeScript[] = [];
  const agents: FakeAgent[] = [];
  const project = opts.project
    ? await Project.ensureForRepo(store, { home: await mkdtemp(join(tmpdir(), "turtle-home-")) })
    : undefined;
  const server = await startServer({
    ...(project ? { project, autoStart: opts.autoStart ?? false } : {}),
    store,
    db,
    config,
    repoRoot: repo,
    staticDir,
    workspaceRoot: `${repo}-ws`,
    summarizer: new HeuristicSummarizer(),
    launcherFor: () =>
      opts.failLaunch
        ? async () => {
            throw new Error("docker image turtle/runner-claude:0.1 not found");
          }
        : fakeLauncher(
            async (a) => {
              const script = scripts.shift();
              if (!script) throw new Error("no script queued");
              await script(a);
            },
            { onAgent: (a) => agents.push(a) },
          ),
  });
  current = server;

  const api = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${server.url}${path}`, {
      method: init.method ?? "GET",
      headers:
        init.body !== undefined ? { "content-type": "application/json", "x-turtle": "1" } : {},
      body: init.body !== undefined ? JSON.stringify(init.body) : null,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const state = async () => (await api<StateResponse>("/api/state")).body;
  const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const branchStatus = (id: string, status: string) =>
    waitFor(async () => (await state()).branches.find((b) => b.id === id && b.status === status));
  return {
    repo,
    store,
    db,
    dbPath,
    server,
    scripts,
    agents,
    api,
    state,
    waitFor,
    branchStatus,
    project,
  };
}

const askScript: FakeScript = async (a) => {
  await a.say("Looking around.");
  await a.tool("Read", { file_path: "a.txt" });
  await a.edit("b.txt", "b\n");
  await a.writeFile("report.html", "<script>alert(1)</script><p>report</p>");
  await a.checkpoint("Add b\n\nCreated b.txt.", "progress", [
    { path: "report.html", label: "report" },
  ]);
  await a.edit("c.txt", "c\n");
  await a.checkpoint("JSON or text?", "need_decision");
  await a.finish("JSON or text?");
};

describe("turtle ui server", () => {
  it("runs an agent from the browser and shows the tree, attention, detail, diff and transcript", async () => {
    const t = await setup();
    expect((await t.state()).branches).toEqual([]);

    t.scripts.push(askScript);
    const run = await t.api<RunResponse>("/api/runs", {
      method: "POST",
      body: { prompt: "do it" },
    });
    expect(run.status).toBe(201);
    expect(run.body.mode).toBe("new");
    await t.branchStatus(run.body.branchId, "idle");

    const s = await t.state();
    const semantic = s.nodes.filter((n) => n.kind === "semantic");
    expect(semantic.map((n) => n.summary?.split("\n")[0])).toEqual(["Add b", "JSON or text?"]);
    expect(s.nodes.some((n) => n.kind === "micro")).toBe(false);
    const [first, second] = semantic;
    expect(first?.hiddenSteps).toBeGreaterThan(0);
    expect(second?.displayParent).toBe(first?.id);
    expect(s.attention).toMatchObject([
      {
        kind: "need_decision",
        branchId: run.body.branchId,
        nodeId: second?.id,
        title: "JSON or text?",
      },
    ]);
    expect(s.agents[0]).toMatchObject({ status: "done", ownedByUi: false });
    expect(s.totals.micro).toBeGreaterThan(0);
    expect((await t.api<StateResponse>("/api/state?micro=1")).body.nodes.length).toBe(
      s.totals.nodes,
    );

    const detail = (await t.api<NodeDetailResponse>(`/api/nodes/${first?.id}`)).body;
    expect(detail.base?.kind).toBe("root");
    expect(detail.steps.map((i) => i.kind)).toContain("tool_use");
    expect(detail.steps.find((i) => i.kind === "text")).toMatchObject({ text: "Looking around." });
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.canContinue).toBe(false);

    const diff = (await t.api<DiffResponse>(`/api/nodes/${first?.id}/diff`)).body;
    expect(diff.diff).toContain("+++ b/b.txt");
    expect(diff.base?.kind).toBe("root");

    // Artifacts are served in a sandbox so their scripts cannot call the API.
    const art = await fetch(`${t.server.url}/api/artifacts/${detail.artifacts[0]?.id}`);
    expect(art.headers.get("content-security-policy")).toContain("sandbox");
    expect(await art.text()).toContain("report");

    const tr = (await t.api<TranscriptResponse>(`/api/agents/${run.body.agentId}/transcript`)).body;
    expect(tr.items.at(-1)?.kind).toBe("result");
    const later = (
      await t.api<TranscriptResponse>(
        `/api/agents/${run.body.agentId}/transcript?after=${tr.lastSeq}`,
      )
    ).body;
    expect(later.items).toEqual([]);

    // Answer: continue the same branch from its head.
    const head = s.branches[0]?.headNodeId as string;
    expect((await t.api<NodeDetailResponse>(`/api/nodes/${head}`)).body.canContinue).toBe(true);
    t.scripts.push(async (a) => {
      await a.edit("d.txt", "json\n");
      await a.finish("Done.");
    });
    const cont = await t.api<RunResponse>("/api/runs", {
      method: "POST",
      body: { prompt: "JSON", from: head },
    });
    expect(cont.body).toMatchObject({ mode: "continue", branchId: run.body.branchId });
    await t.branchStatus(run.body.branchId, "done");
    expect((await t.state()).attention).toEqual([]);

    // Fork from the first checkpoint.
    t.scripts.push(async (a) => {
      await a.edit("e.txt", "text\n");
      await a.checkpoint("Plain text instead", "done");
      await a.finish();
    });
    const fork = await t.api<RunResponse>("/api/runs", {
      method: "POST",
      body: { prompt: "Use text", from: first?.id, name: "text" },
    });
    expect(fork.body.mode).toBe("fork");
    await t.branchStatus(fork.body.branchId, "done");
    const after = await t.state();
    const forkNode = after.nodes.find((n) => n.summary === "Plain text instead");
    expect(forkNode?.displayParent).toBe(first?.id);
    expect(after.branches.find((b) => b.id === fork.body.branchId)?.name).toBe("text");
  });

  it("stops its own runs directly and runs of other processes through stop requests", async () => {
    const t = await setup();
    t.scripts.push(async (a) => {
      await a.edit("x.txt", "x\n");
      await a.waitForInterrupt();
      await a.say("never");
    });
    const run = await t.api<RunResponse>("/api/runs", { method: "POST", body: { prompt: "long" } });
    await t.waitFor(async () => (await t.state()).agents[0]?.status === "running");
    expect((await t.state()).agents[0]?.ownedByUi).toBe(true);
    const stop = await t.api<{ results: { via: string }[] }>(
      `/api/branches/${run.body.branchId}/stop`,
      { method: "POST", body: {} },
    );
    expect(stop.body.results[0]?.via).toBe("direct");
    await t.branchStatus(run.body.branchId, "killed");

    // `turtle stop` from another process writes a stop_request the server picks up.
    t.scripts.push(async (a) => {
      await a.waitForInterrupt();
      await a.say("never");
    });
    const run2 = await t.api<RunResponse>("/api/runs", {
      method: "POST",
      body: { prompt: "long" },
    });
    await t.waitFor(async () =>
      (await t.state()).agents.find((a) => a.id === run2.body.agentId && a.status === "running"),
    );
    const otherDb = TurtleDb.open(t.dbPath);
    const branch = otherDb.getBranch(run2.body.branchId);
    if (!branch) throw new Error("branch missing");
    const results = await requestStop(t.store, otherDb, branch);
    expect(results[0]?.via).toBe("request");
    otherDb.close();
    await t.branchStatus(run2.body.branchId, "killed");

    const none = await t.api<{ error: string }>(`/api/branches/${run2.body.branchId}/stop`, {
      method: "POST",
      body: {},
    });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no running agent/);
  });

  it("pushes a change event when another process writes", async () => {
    const t = await setup();
    const res = await fetch(`${t.server.url}/api/events`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('"hello"');
    const other = TurtleDb.open(t.dbPath);
    other.setMeta("x", "1");
    other.close();
    expect(await read()).toContain('"change"');
    await reader.cancel();
  });

  it("tags and exports nodes, with errors as 400", async () => {
    const t = await setup();
    t.scripts.push(async (a) => {
      await a.edit("b.txt", "b\n");
      await a.checkpoint("Add b", "done");
      await a.finish();
    });
    const run = await t.api<RunResponse>("/api/runs", { method: "POST", body: { prompt: "b" } });
    await t.branchStatus(run.body.branchId, "done");
    const node = (await t.state()).nodes.find((n) => n.kind === "semantic");
    const tag = await t.api(`/api/nodes/${node?.id}/tag`, { method: "POST", body: { name: "v1" } });
    expect(tag.status).toBe(200);
    expect((await t.state()).snapshots).toMatchObject([{ name: "v1", nodeId: node?.id }]);
    const bad = await t.api<{ error: string }>(`/api/nodes/${node?.id}/tag`, {
      method: "POST",
      body: { name: "../x" },
    });
    expect(bad.status).toBe(400);
    const exp = await t.api<{ branch: string; commit: string }>(`/api/nodes/${node?.id}/export`, {
      method: "POST",
      body: { branch: "feat/b" },
    });
    expect(exp.status).toBe(200);
    expect(await git(["show", "feat/b:b.txt"], { cwd: t.repo })).toBe("b");
    const dup = await t.api(`/api/nodes/${node?.id}/export`, {
      method: "POST",
      body: { branch: "feat/b" },
    });
    expect(dup.status).toBe(400);
  });

  it("records a failed launch so the attention queue explains it", async () => {
    const t = await setup({ failLaunch: true });
    const run = await t.api<{ error: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "x", sandbox: "docker" },
    });
    expect(run.status).toBe(500);
    expect(run.body.error).toMatch(/docker image/);
    const s = await t.state();
    expect(s.branches[0]?.status).toBe("failed");
    expect(s.attention[0]).toMatchObject({
      kind: "failed",
      detail: expect.stringMatching(/docker/),
    });
  });

  it("rejects foreign hosts, cross-site writes and path traversal", async () => {
    const t = await setup();
    const raw = (path: string, headers: Record<string, string>, method = "GET", body = "") =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: t.server.port, path, method, headers },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    expect(await raw("/api/state", { host: "evil.example:80" })).toBe(403);
    expect(await raw("/api/state", { host: `localhost:${t.server.port}` })).toBe(200);
    const post = { host: `127.0.0.1:${t.server.port}`, "content-type": "application/json" };
    expect(await raw("/api/runs", post, "POST", "{}")).toBe(403); // no x-turtle header
    expect(
      await raw(
        "/api/runs",
        { ...post, "x-turtle": "1", origin: "https://evil.example" },
        "POST",
        "{}",
      ),
    ).toBe(403);
    expect(
      await raw(
        "/api/runs",
        { ...post, "x-turtle": "1", "content-type": "text/plain" },
        "POST",
        "{}",
      ),
    ).toBe(415);
    expect(await raw("/api/runs", { ...post, "x-turtle": "1" }, "POST", "{}")).toBe(400);

    const res = await fetch(`${t.server.url}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(await res.text()).toContain("<title>turtle</title>");
    expect((await fetch(`${t.server.url}/some/route`)).status).toBe(200);
  });

  it("serves the task graph: create, edit, deltas, answer, undo", async () => {
    const t = await setup({ project: true });
    const proj = (await t.api<{ name: string; sources: unknown[] }>("/api/project")).body;
    expect(proj.sources).toHaveLength(1);
    const goal = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "goal", parentId: null, title: "Measure A" },
      })
    ).body;
    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Set up phone", bogus: "ignored" },
      })
    ).body;
    expect(task).toMatchObject({ status: "todo", parentId: goal.id });
    const full = (await t.api<GraphResponse>("/api/graph")).body;
    expect(full.full).toBe(true);
    expect(full.concepts.map((c) => c.id).sort()).toEqual([goal.id, task.id].sort());

    const edited = (
      await t.api<Concept>(`/api/concepts/${task.id}`, {
        method: "POST",
        body: { fields: { title: "Set up the phone" } },
      })
    ).body;
    expect(edited.version).toBe(2);
    const delta = (await t.api<GraphResponse>(`/api/graph?since=${full.cursor}`)).body;
    expect(delta.full).toBe(false);
    expect(delta.concepts.map((c) => c.id)).toEqual([task.id]);

    const q = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "question", parentId: task.id, title: "USB or Wi-Fi adb?" },
      })
    ).body;
    const d = (
      await t.api<{ decision: Concept }>(`/api/questions/${q.id}/answer`, {
        method: "POST",
        body: { text: "USB" },
      })
    ).body.decision;
    expect(d).toMatchObject({ kind: "decision", title: "USB", parentId: task.id });
    const detail = (await t.api<ConceptDetailResponse>(`/api/concepts/${q.id}`)).body;
    expect(detail.concept.answer?.text).toBe("USB");
    expect(detail.backlinks.map((l) => l.rel)).toEqual(["provenance"]);

    const lastOp = detail.history.at(-1)?.id as string;
    await t.api(`/api/ops/${lastOp}/undo`, { method: "POST", body: {} });
    expect(
      (await t.api<ConceptDetailResponse>(`/api/concepts/${q.id}`)).body.concept.answer ?? null,
    ).toBeNull();

    expect((await t.api("/api/concepts/c_nope")).status).toBe(404);
    expect(
      (
        await t.api("/api/concepts", {
          method: "POST",
          body: { kind: "task", parentId: null, title: "x" },
        })
      ).status,
    ).toBe(400);
    t.project?.close();
  });

  it("runs tasks from the browser: start, question, answer and continue, tell, pause, abandon, retry", async () => {
    const t = await setup({ project: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "Trade every 8 hours" },
      })
    ).body.goal;
    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Signal", assignee: { type: "agent" } },
      })
    ).body;
    t.scripts.push(async (a) => {
      await a.edit("framework.py", "r1\n");
      await a.checkpoint("Framework r1", "progress");
      await a.graph("question", { text: "Daily or hourly bars?" });
      await a.finish("Daily or hourly?");
    });
    const started = await t.api<{ mode: string }>(`/api/tasks/${task.id}/start`, {
      method: "POST",
      body: {},
    });
    expect(started.body.mode).toBe("new");
    const conceptStatus = async (id: string, status: string) =>
      t.waitFor(
        async () =>
          (await t.api<ConceptDetailResponse>(`/api/concepts/${id}`)).body.concept.status ===
          status,
      );
    await conceptStatus(task.id, "need_decision");
    const graph = (await t.api<GraphResponse>("/api/graph")).body;
    const q = graph.concepts.find((c) => c.kind === "question");

    // Answering continues the same branch with the answer.
    let continued = "";
    t.scripts.push(async (a) => {
      continued = a.prompt;
      await a.edit("bars.py", "daily\n");
      await a.checkpoint("Daily bars", "done");
      await a.finish();
    });
    const ans = await t.api<{ started: { mode: string } }>(`/api/questions/${q?.id}/answer`, {
      method: "POST",
      body: { text: "Daily" },
    });
    // "queued" when the run that asked was still ending; it continues right after.
    expect(["continue", "queued"]).toContain(ans.body.started.mode);
    await conceptStatus(task.id, "done");
    expect(continued).toContain("Daily or hourly bars? → Daily");

    // A second task: tell it something while it works, then pause it.
    const b = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Approach A", assignee: { type: "agent" } },
      })
    ).body;
    const heard: string[] = [];
    t.scripts.push(async (a) => {
      await a.edit("a.txt", "a\n");
      for (;;) {
        await a.tool("Read", { file_path: "a.txt" });
        heard.push(...a.instructions.splice(0));
      }
    });
    await t.api(`/api/tasks/${b.id}/start`, { method: "POST", body: {} });
    await conceptStatus(b.id, "running");
    await t.api(`/api/tasks/${b.id}/tell`, {
      method: "POST",
      body: { text: "Use 6 months out of sample" },
    });
    await t.waitFor(async () => heard.length > 0);
    expect(heard).toEqual(["Use 6 months out of sample"]);
    await t.api(`/api/tasks/${b.id}/pause`, { method: "POST", body: {} });
    await conceptStatus(b.id, "paused");

    // Abandon it into a lesson, and retry under the goal.
    const ab = await t.api<{ lesson: Concept }>(`/api/tasks/${b.id}/abandon`, {
      method: "POST",
      body: { lesson: "Look-ahead bias: only use data known before t-1" },
    });
    expect(ab.body.lesson).toMatchObject({
      kind: "lesson",
      parentId: goal.id,
      lessonState: "confirmed",
    });
    const retry = await t.api<Concept>(`/api/nodes-retry/${goal.id}`, {
      method: "POST",
      body: { title: "Approach B" },
    });
    expect(retry.body).toMatchObject({ kind: "task", parentId: goal.id });
    const detail = (await t.api<ConceptDetailResponse>(`/api/concepts/${retry.body.id}`)).body;
    expect(detail.lessons.map((l) => l.title)).toEqual([
      "Look-ahead bias: only use data known before t-1",
    ]);

    const act = (await t.api<{ text: string; byAgent: boolean }[]>("/api/activity")).body;
    expect(act.some((x) => x.byAgent && x.text.startsWith("asked:"))).toBe(true);
    expect(act.some((x) => !x.byAgent && x.text.startsWith("added a lesson"))).toBe(true);
    t.project?.close();
  });

  it("serves an output's content, starts a task from another's checkpoint, rejects dependency cycles", async () => {
    const t = await setup({ project: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "Measure model A on a phone" },
      })
    ).body.goal;
    const mk = async (title: string, extra: Record<string, unknown> = {}) =>
      (
        await t.api<Concept>("/api/concepts", {
          method: "POST",
          body: { kind: "task", parentId: goal.id, title, assignee: { type: "agent" }, ...extra },
        })
      ).body;
    const a = await mk("Compile model A");
    t.scripts.push(async (ag) => {
      await ag.writeFile("results/a.csv", "run,power_mw\n1,812\n");
      await ag.graph("finding", {
        text: "812 mW",
        evidence: [{ path: "results/a.csv" }],
      });
      await ag.checkpoint("Compiled A", "done");
      await ag.finish();
    });
    await t.api(`/api/tasks/${a.id}/start`, { method: "POST", body: {} });
    await t.waitFor(
      async () =>
        (await t.api<ConceptDetailResponse>(`/api/concepts/${a.id}`)).body.concept.status ===
        "done",
    );
    const graph = (await t.api<GraphResponse>("/api/graph")).body;
    const out = graph.concepts.find((c) => c.kind === "output");
    const content = await t.api<OutputContentResponse>(`/api/outputs/${out?.id}`);
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ path: "results/a.csv", matches: true, binary: false });
    expect(content.body.text).toBe("run,power_mw\n1,812\n");
    expect((await t.api(`/api/outputs/${goal.id}`)).status).toBe(404);

    // Model B reuses A's environment: it starts from A's latest checkpoint.
    const b = await t.api<Concept>(`/api/tasks/${a.id}/from-here`, {
      method: "POST",
      body: { title: "Compile model B" },
    });
    expect(b.body).toMatchObject({ parentId: goal.id, startFrom: { taskId: a.id } });
    let sawFile = false;
    t.scripts.push(async (ag) => {
      sawFile = existsSync(join(ag.workspace, "results/a.csv"));
      await ag.checkpoint("Compiled B", "done");
      await ag.finish();
    });
    const started = await t.api<{ mode: string }>(`/api/tasks/${b.body.id}/start`, {
      method: "POST",
      body: {},
    });
    expect(started.body.mode).toBe("fork");
    await t.waitFor(
      async () =>
        (await t.api<ConceptDetailResponse>(`/api/concepts/${b.body.id}`)).body.concept.status ===
        "done",
    );
    expect(sawFile).toBe(true);

    // Waiting on each other is refused.
    const c = await mk("Measure", { dependsOn: [b.body.id] });
    const cycle = await t.api(`/api/concepts/${b.body.id}`, {
      method: "POST",
      body: { fields: { dependsOn: [c.id] } },
    });
    expect(cycle.status).toBe(400);
    expect(
      (await t.api(`/api/tasks/${c.id}/from-here`, { method: "POST", body: { title: "x" } }))
        .status,
    ).toBe(400);
    t.project?.close();
  });

  it("adds a check to a lesson, enforces it on a task run, and runs it on demand", async () => {
    const t = await setup({ project: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "Trade", plan: false },
      })
    ).body.goal;
    const lesson = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: {
          kind: "lesson",
          parentId: goal.id,
          title: "Keep a README",
          lessonState: "confirmed",
        },
      })
    ).body;
    const check = await t.api<Concept>("/api/checks", {
      method: "POST",
      body: {
        on: lesson.id,
        title: "NOTES.md exists",
        file: "notes.sh",
        script: 'test -f NOTES.md || { echo "NOTES.md is missing"; exit 1; }\n',
      },
    });
    expect(check.body).toMatchObject({ kind: "check", parentId: goal.id, checkState: "active" });
    expect(
      (
        await t.api("/api/checks", {
          method: "POST",
          body: { on: goal.id, title: "x", file: "x.exe", script: "x" },
        })
      ).status,
    ).toBe(400);

    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Write it", assignee: { type: "agent" } },
      })
    ).body;
    t.scripts.push(async (a) => {
      await a.edit("x.txt", "x\n");
      await a.checkpoint("Wrote x", "done");
      await a.finish();
    });
    await t.api(`/api/tasks/${task.id}/start`, { method: "POST", body: {} });
    await t.waitFor(
      async () =>
        (await t.api<ConceptDetailResponse>(`/api/concepts/${task.id}`)).body.concept.status ===
        "blocked",
    );
    const act = (await t.api<{ text: string }[]>("/api/activity")).body;
    expect(act.some((x) => x.text.startsWith("added a check:"))).toBe(true);
    expect(act.some((x) => /checks on "Write it": 1 failed/.test(x.text))).toBe(true);

    // Fixed by hand in the workspace, then run on demand.
    const ws = t.db.getBranch(
      (await t.api<ConceptDetailResponse>(`/api/concepts/${task.id}`)).body.concept.branches?.[0]
        ?.branch ?? "",
    )?.workspacePath;
    await writeFile(join(ws ?? "", "NOTES.md"), "notes\n");
    const now = await t.api<CheckRunResponse>(`/api/tasks/${task.id}/checks`, {
      method: "POST",
      body: {},
    });
    expect(now.body.results).toMatchObject([{ checkId: check.body.id, ok: true }]);
    t.project?.close();
  });

  it("verifies a recipe when its run ends, replays it without a model, and lets an agent repair a failed replay", async () => {
    const t = await setup({ project: true, autoStart: true });
    const compileSh =
      'set -e\nmkdir -p build\ncase "$MODEL" in A) ;; *) echo "cannot lower Conv3D for $MODEL" >&2; exit 2 ;; esac\nprintf "model=%s\\n" "$MODEL" > "build/model-$MODEL.bin"\n';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a recipe output pattern, expanded by turtle.
    const out = "build/model-${MODEL}.bin";
    t.scripts.push(async (a) => {
      await a.writeFile("build/compile.sh", compileSh);
      await a.writeFile("build/model-A.bin", "model=A\n");
      await a.checkpoint("Compiled A", "done");
      await a.graph("recipe", {
        title: "Compile",
        file: "compile.sh",
        script: "bash build/compile.sh\n",
        params: { MODEL: "A" },
        outputs: [out],
      });
      await a.finish();
    });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "Phone", plan: false },
      })
    ).body.goal;
    const compile = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Compile", assignee: { type: "agent" } },
      })
    ).body;
    const graph = async () => (await t.api<GraphResponse>("/api/graph")).body.concepts;
    const recipe = await t.waitFor(async () =>
      (await graph()).find((c) => c.kind === "recipe" && c.recipeState === "verified"),
    );
    expect(recipe.parentId).toBe(compile.id);

    // The repair agent's script (the replay itself runs no agent).
    t.scripts.push(async (a) => {
      expect(a.prompt).toContain("It FAILED");
      await a.edit("build/compile.sh", compileSh.replace("A) ;;", "A|B) ;;"));
      await a.writeFile("build/model-B.bin", "model=B\n");
      await a.checkpoint("Compiled B", "done");
      await a.graph("recipe", {
        title: "Compile",
        file: "compile.sh",
        script: "bash build/compile.sh\n",
        params: { MODEL: "B" },
        outputs: [out],
      });
      await a.finish();
    });
    const replay = await t.api<Concept>(`/api/recipes/${recipe.id}/replay`, {
      method: "POST",
      body: { params: { MODEL: "B" } },
    });
    expect(replay.body).toMatchObject({
      title: "Compile (MODEL=B)",
      replay: { params: { MODEL: "B" } },
    });
    const done = await t.waitFor(async () =>
      (await graph()).find((c) => c.id === replay.body.id && c.status === "done"),
    );
    expect(done.replay).toMatchObject({ repairs: 1, result: { ok: false } });
    await t.waitFor(async () =>
      (await graph()).find(
        (c) => c.kind === "recipe" && c.parentId === replay.body.id && c.recipeState === "verified",
      ),
    );
    const act = (await t.api<{ text: string }[]>("/api/activity")).body;
    expect(act.some((x) => x.text.startsWith('the recipe failed for "Compile (MODEL=B)"'))).toBe(
      true,
    );
    t.project?.close();
  });

  it("exports a task or goal, records judgments, and reports the gate", async () => {
    const t = await setup({ project: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "Ship", plan: false },
      })
    ).body.goal;
    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Notes", assignee: { type: "agent" } },
      })
    ).body;
    t.scripts.push(async (a) => {
      await a.writeFile("r.csv", "a,b\n1,2\n");
      await a.graph("finding", { text: "Two columns", evidence: [{ path: "r.csv" }] });
      await a.checkpoint("Notes", "done");
      await a.finish();
    });
    await t.api(`/api/tasks/${task.id}/start`, { method: "POST", body: {} });
    await t.waitFor(
      async () =>
        (await t.api<ConceptDetailResponse>(`/api/concepts/${task.id}`)).body.concept.status ===
        "done",
    );
    const summary = await t.api<ExportSummaryResponse>(`/api/concepts/${goal.id}/export`);
    expect(summary.body).toMatchObject({
      counts: { goals: 1, tasks: 1, findings: 1 },
      inlined: 1,
      leaks: [],
    });
    expect((summary.body as unknown as { html?: string }).html).toBeUndefined();
    const file = await fetch(`${t.server.url}/api/concepts/${goal.id}/export?format=html`);
    expect(file.headers.get("content-disposition")).toMatch(/attachment; filename="ship-/);
    expect(await file.text()).toContain("<td>1</td>");
    await t.api(`/api/exports/${goal.id}/judge`, {
      method: "POST",
      body: { clear: { goal: true, results: true, decisions: true, openQuestions: true } },
    });
    const gate = (await t.api<GateResponse>("/api/gate")).body;
    expect(gate.groups.map((g) => g.id)).toEqual(["G1", "G2", "G3", "G4", "G5", "latency"]);
    expect(gate.groups[2]?.metrics[0]?.display).toBe("1 of 1");
    expect(typeof gate.canAudit).toBe("boolean");
    t.project?.close();
  });

  it("sets the project's agent defaults (model, thinking effort)", async () => {
    const t = await setup({ project: true });
    const r = await t.api<Record<string, unknown>>("/api/project/defaults", {
      method: "POST",
      body: { model: "claude-sonnet-5-5", effort: "xhigh" },
    });
    expect(r.body).toMatchObject({ model: "claude-sonnet-5-5", effort: "xhigh" });
    expect(
      (await t.api("/api/project/defaults", { method: "POST", body: { effort: "huge" } })).status,
    ).toBe(400);
    const p = await t.api<{ defaults: Record<string, unknown> }>("/api/project");
    expect(p.body.defaults).toMatchObject({ effort: "xhigh" });
    await t.api("/api/project/defaults", { method: "POST", body: { effort: null } });
    expect(
      (await t.api<{ defaults: Record<string, unknown> }>("/api/project")).body.defaults.effort,
    ).toBeUndefined();
    t.project?.close();
  });

  it("plans and runs a path replay, then lets an agent continue with the next step", async () => {
    const t = await setup({ project: true, autoStart: true });
    t.scripts.push(async (a) => {
      await a.writeFile("src/a.txt", "a\n");
      await a.checkpoint("Step one", "progress");
      await a.writeFile("src/b.txt", "b\n");
      await a.checkpoint("Step two", "done");
      await a.finish();
    });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "G", plan: false },
      })
    ).body.goal;
    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Two steps", assignee: { type: "agent" } },
      })
    ).body;
    const status = async (id: string) =>
      (await t.api<ConceptDetailResponse>(`/api/concepts/${id}`)).body.concept;
    await t.waitFor(async () => (await status(task.id)).status === "done");
    const plan = await t.api<{ steps: { mode: string; paths: string[] }[] }>("/api/replays/plan", {
      method: "POST",
      body: { taskId: task.id },
    });
    expect(plan.body.steps.map((s) => s.paths.join())).toEqual(["src/a.txt", "src/b.txt"]);

    let nextPrompt = "";
    t.scripts.push(async (a) => {
      nextPrompt = a.prompt;
      await a.checkpoint("Compared", "done");
      await a.finish();
    });
    const r = await t.api<Concept>("/api/replays", {
      method: "POST",
      body: { taskId: task.id, onto: "repo", next: "Compare with the original" },
    });
    expect(r.body.title).toBe("Two steps (on your repository)");
    await t.waitFor(async () => (await status(r.body.id)).replay?.nextStarted === true);
    await t.waitFor(async () => nextPrompt !== "" && (await status(r.body.id)).status === "done");
    expect(nextPrompt).toContain("Compare with the original");
    expect((await status(r.body.id)).replay?.result?.ok).toBe(true);
    t.project?.close();
  });
  it("replays a task with its upstream tasks, in order, without a model", async () => {
    const t = await setup({ project: true, autoStart: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "G", plan: false },
      })
    ).body.goal;
    const status = async (id: string) =>
      (await t.api<ConceptDetailResponse>(`/api/concepts/${id}`)).body.concept;
    t.scripts.push(async (a) => {
      await a.writeFile("data.txt", "data\n");
      await a.checkpoint("Fetched", "done");
      await a.finish();
    });
    const up = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Fetch", assignee: { type: "agent" } },
      })
    ).body;
    await t.waitFor(async () => (await status(up.id)).status === "done");
    t.scripts.push(async (a) => {
      await a.writeFile("model.txt", "model\n");
      await a.checkpoint("Modelled", "done");
      await a.finish();
    });
    const down = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: {
          kind: "task",
          parentId: goal.id,
          title: "Model",
          assignee: { type: "agent" },
          dependsOn: [up.id],
          startFrom: { taskId: up.id, checkpointId: "latest" },
        },
      })
    ).body;
    await t.waitFor(async () => (await status(down.id)).status === "done");
    const plan = await t.api<{ title: string; steps: unknown[] }[]>("/api/replays/chain/plan", {
      method: "POST",
      body: { taskId: down.id },
    });
    expect(plan.body.map((l) => [l.title, l.steps.length])).toEqual([
      ["Fetch", 1],
      ["Model", 1],
    ]);
    const made = await t.api<Concept[]>("/api/replays/chain", {
      method: "POST",
      body: { taskId: down.id, onto: "repo" },
    });
    expect(made.body).toHaveLength(2);
    const [a2, b2] = made.body as [Concept, Concept];
    await t.waitFor(async () => (await status(b2.id)).status === "done");
    expect((await status(a2.id)).replay?.result?.ok).toBe(true);
    expect((await status(b2.id)).replay?.result?.ok).toBe(true);
    t.project?.close();
  });
  it("does not crash when the project closes while a run is ending", async () => {
    const t = await setup({ project: true });
    const goal = (
      await t.api<{ goal: Concept }>("/api/goals", {
        method: "POST",
        body: { title: "G", plan: false },
      })
    ).body.goal;
    const task = (
      await t.api<Concept>("/api/concepts", {
        method: "POST",
        body: { kind: "task", parentId: goal.id, title: "Slow", assignee: { type: "agent" } },
      })
    ).body;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t.scripts.push(async (a) => {
      await a.writeFile("a.txt", "a\n");
      await gate;
      await a.finish();
    });
    await t.api(`/api/tasks/${task.id}/start`, { method: "POST", body: {} });
    await t.waitFor(
      async () =>
        (await t.api<ConceptDetailResponse>(`/api/concepts/${task.id}`)).body.concept.status ===
        "running",
    );
    t.project?.close();
    release();
    // The run ends on a closed project: its follow-up work must not throw unhandled.
    await new Promise((r) => setTimeout(r, 1500));
  });
});
