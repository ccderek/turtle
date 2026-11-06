import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  diffBaseOf,
  exportNode,
  type GitStore,
  OpsError,
  type Project,
  RefConflictError,
  type RunEvent,
  type RunnerLauncher,
  type RunOptions,
  RunSession,
  reconcile,
  requestStop,
  type SandboxMode,
  type Summarizer,
  stepNodeIds,
  type TurtleConfig,
  type TurtleDb,
  tagNode,
  uiOwnerFileFor,
} from "@turtle/core";
import type {
  DiffResponse,
  LiveEvent,
  NodeDetailResponse,
  RunRequest,
  RunResponse,
  TranscriptResponse,
} from "./api.js";
import { graphRoutes, RouteError } from "./graph-routes.js";
import { StateBuilder, transcriptItems } from "./views.js";

const POLL_MS = 250;
const RECONCILE_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1_000_000;
const MAX_DIFF_CHARS = 2_000_000;
const SHUTDOWN_GRACE_MS = 15_000;

export interface ServerOptions {
  store: GitStore;
  db: TurtleDb;
  config: TurtleConfig;
  repoRoot: string;
  launcherFor: (sandbox: SandboxMode, config: TurtleConfig) => RunnerLauncher;
  summarizer: Summarizer;
  /** Built web client (index.html + assets); null serves a placeholder page. */
  staticDir: string | null;
  port?: number;
  /** Where workspaces live (tests); default ~/.turtle/workspaces/<repo>. */
  workspaceRoot?: string;
  log?: (line: string) => void;
  /** The task graph this server serves (Phase 2). */
  project?: Project;
}

export interface TurtleServer {
  url: string;
  port: number;
  server: Server;
  /** Sessions started by this process, by agent id. */
  sessions: ReadonlyMap<string, RunSession>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `turtle ui`: a local HTTP server over the repo's turtle state (docs/phase1-spec.md §3).
 * It is also an orchestrator: runs started from the browser live in this process.
 */
export async function startServer(o: ServerOptions): Promise<TurtleServer> {
  const { store, db, config } = o;
  const log = o.log ?? (() => {});
  const sessions = new Map<string, RunSession>();
  const views = new StateBuilder(db, config, o.repoRoot, () => new Set(sessions.keys()));
  const clients = new Set<ServerResponse>();
  let port = 0;

  const broadcast = (e: LiveEvent) => {
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(frame);
  };

  // ------------------------------------------------------------ live loop
  const graph = o.project ? graphRoutes(o.project) : null;
  const changeToken = () => `${db.changeToken()}|${o.project?.db.changeToken() ?? ""}`;
  let lastToken = changeToken();
  let stopSeq = db.listEvents({ type: "stop_request" }).at(-1)?.seq ?? 0;
  const poll = setInterval(() => {
    const token = changeToken();
    if (token === lastToken) return;
    lastToken = token;
    for (const e of db.listEvents({ type: "stop_request", afterSeq: stopSeq })) {
      stopSeq = e.seq;
      const s = e.agentId ? sessions.get(e.agentId) : undefined;
      if (s) s.interrupt();
    }
    broadcast({ type: "change" });
  }, POLL_MS);
  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    reconcile(store, db)
      .catch((err) => log(`reconcile failed: ${(err as Error).message}`))
      .finally(() => {
        reconciling = false;
      });
  }, RECONCILE_MS);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, HEARTBEAT_MS);

  // -------------------------------------------------------------- actions
  async function startRun(body: RunRequest): Promise<RunResponse> {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "prompt is required");
    const sandbox = body.sandbox ?? config.sandbox.mode;
    if (sandbox !== "none" && sandbox !== "docker")
      throw new HttpError(400, `unknown sandbox: ${String(sandbox)}`);
    const opts: RunOptions = { prompt, sandbox };
    if (body.from) {
      if (!db.getNode(body.from)) throw new HttpError(404, `unknown node: ${body.from}`);
      opts.from = body.from;
    }
    if (body.fork) opts.fork = true;
    if (body.fromHead) opts.fromHead = true;
    if (body.model?.trim()) opts.model = body.model.trim();
    if (body.name?.trim()) opts.name = body.name.trim();
    if (body.budget !== undefined && body.budget !== null) {
      const budget = Number(body.budget);
      if (!Number.isFinite(budget) || budget <= 0) throw new HttpError(400, "invalid budget");
      opts.maxBudgetUsd = budget;
    }
    let branchId = "";
    let agentId = "";
    const onEvent = (e: RunEvent) => {
      if (e.type === "started") {
        branchId = e.branch.id;
        agentId = e.agentId;
      } else if (e.type === "log" && e.level !== "info" && !e.message.startsWith("interrupting")) {
        broadcast({ type: "log", agentId, branchId, level: e.level, message: e.message });
        log(`[${agentId.slice(0, 6)}] ${e.message}`);
      }
    };
    let session: RunSession;
    try {
      session = await RunSession.start(
        {
          store,
          db,
          config,
          launcher: o.launcherFor(sandbox, config),
          summarizer: o.summarizer,
          onEvent,
          ...(o.workspaceRoot ? { workspaceRoot: o.workspaceRoot } : {}),
        },
        opts,
      );
    } catch (err) {
      const msg = (err as Error).message;
      if (/is running; use --fork/.test(msg))
        throw new HttpError(409, "that branch is running; fork from it instead");
      throw new HttpError(500, msg);
    }
    const ownerFile = uiOwnerFileFor(store, session.agentId);
    await mkdir(join(store.turtleDir, "run"), { recursive: true });
    await writeFile(ownerFile, String(process.pid));
    sessions.set(session.agentId, session);
    log(`run ${session.agentId} started on branch ${session.branchId} (${session.mode})`);
    void session.done.then(async (outcome) => {
      sessions.delete(session.agentId);
      await rm(ownerFile, { force: true });
      log(
        `run ${session.agentId} ended: ${outcome.reason}${outcome.error ? ` (${outcome.error})` : ""}`,
      );
    });
    return { agentId: session.agentId, branchId: session.branchId, mode: session.mode };
  }

  async function stopBranch(branchId: string): Promise<{ results: unknown[] }> {
    const branch = db.getBranch(branchId);
    if (!branch) throw new HttpError(404, `unknown branch: ${branchId}`);
    const owned = [...sessions.values()].filter((s) => s.branchId === branchId);
    if (owned.length) {
      for (const s of owned) s.interrupt();
      return {
        results: owned.map((s) => ({ agentId: s.agentId, via: "direct", detail: "interrupting" })),
      };
    }
    return { results: await requestStop(store, db, branch) };
  }

  function nodeDetail(id: string): NodeDetailResponse {
    const byId = views.nodesById();
    const node = views.nodeView(id, byId);
    if (!node) throw new HttpError(404, `unknown node: ${id}`);
    const branch = views.branchViews(byId).find((b) => b.id === node.branchId) ?? null;
    const agent = node.agentId ? views.agentView1(node.agentId) : null;
    const baseNode = diffBaseOf(db, node);
    const steps: NodeDetailResponse["steps"] = [];
    if (node.agentId) {
      const ids = new Set(stepNodeIds(db, node));
      const msgs = db.listMessages(node.agentId).filter((m) => m.nodeId && ids.has(m.nodeId));
      steps.push(...transcriptItems(msgs, agent?.prompt));
    }
    return {
      node,
      branch,
      agent,
      base: baseNode ? views.nodeView(baseNode.id, byId) : null,
      children: db
        .childrenOf(id)
        .map((c) => views.nodeView(c.id, byId))
        .filter((c) => c !== null),
      artifacts: db.listArtifacts(id),
      snapshots: db
        .listSnapshots()
        .filter((s) => s.nodeId === id)
        .map((s) => s.name),
      steps,
      canContinue: Boolean(branch && branch.headNodeId === id && branch.status !== "running"),
    };
  }

  async function nodeDiff(id: string, baseParam: string | null): Promise<DiffResponse> {
    const n = db.getNode(id);
    if (!n) throw new HttpError(404, `unknown node: ${id}`);
    const base =
      baseParam === "parent"
        ? n.parents[0]
          ? db.getNode(n.parents[0])
          : null
        : baseParam && baseParam !== "checkpoint"
          ? db.getNode(baseParam)
          : diffBaseOf(db, n);
    if (baseParam && baseParam !== "parent" && baseParam !== "checkpoint" && !base)
      throw new HttpError(404, `unknown node: ${baseParam}`);
    const diff = await store.diff(base?.treeSha ?? (await store.emptyTree()), n.treeSha);
    const truncated = diff.length > MAX_DIFF_CHARS;
    return {
      base: base ? { id: base.id, kind: base.kind } : null,
      diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff,
      truncated,
    };
  }

  function transcript(agentId: string, after: number): TranscriptResponse {
    const agent = views.agentView1(agentId);
    if (!agent) throw new HttpError(404, `unknown agent: ${agentId}`);
    const msgs = db.listMessages(agentId, { afterSeq: after });
    return {
      agent,
      items: transcriptItems(msgs, agent.prompt),
      lastSeq: msgs.at(-1)?.seq ?? after,
    };
  }

  // -------------------------------------------------------------- routing
  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const [api, a, b, c] = parts;
    if (api !== "api") return serveStatic(res, url.pathname);

    if (method === "GET") {
      if (a === "state" && !b)
        return json(res, views.state({ micro: url.searchParams.has("micro") }));
      if (a === "events" && !b) return openStream(req, res);
      if (a === "nodes" && b && !c) return json(res, nodeDetail(b));
      if (a === "nodes" && b && c === "diff")
        return json(res, await nodeDiff(b, url.searchParams.get("base")));
      if (a === "agents" && b && c === "transcript")
        return json(res, transcript(b, Number(url.searchParams.get("after") ?? 0) || 0));
      if (a === "artifacts" && b && !c) return serveArtifact(res, b);
      const g = graph?.get(parts, url);
      if (g !== undefined) return json(res, g);
      throw new HttpError(404, "not found");
    }
    if (method === "POST") {
      checkMutation(req);
      const body = await readJson(req);
      if (a === "runs" && !b) return json(res, await startRun(body as unknown as RunRequest), 201);
      const g = graph ? await graph.post(parts, body) : undefined;
      if (g !== undefined) return json(res, g);
      if (a === "branches" && b && c === "stop") return json(res, await stopBranch(b));
      if (a === "nodes" && b && c === "tag") {
        const n = db.getNode(b);
        if (!n) throw new HttpError(404, `unknown node: ${b}`);
        const name = String((body as { name?: unknown }).name ?? "");
        return json(res, await tagNode(store, db, n, name));
      }
      if (a === "nodes" && b && c === "export") {
        const n = db.getNode(b);
        if (!n) throw new HttpError(404, `unknown node: ${b}`);
        const { branch, message } = body as { branch?: unknown; message?: unknown };
        return json(
          res,
          await exportNode(store, db, n, {
            branch: String(branch ?? ""),
            ...(typeof message === "string" && message.trim() ? { message: message.trim() } : {}),
          }),
        );
      }
      throw new HttpError(404, "not found");
    }
    throw new HttpError(405, "method not allowed");
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({ type: "hello", pid: process.pid } satisfies LiveEvent)}\n\n`,
    );
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  async function serveArtifact(res: ServerResponse, id: string): Promise<void> {
    const a = db.getArtifact(id);
    if (!a) throw new HttpError(404, `unknown artifact: ${id}`);
    const data = await store.readBlob(a.blobSha);
    const mime = a.mime ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime,
      // Artifacts are agent-written: render them in an opaque origin with no API access.
      "content-security-policy":
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "content-length": data.length,
    });
    res.end(data);
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!o.staticDir) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>turtle</title><p>The web client is not built. Run <code>pnpm build</code> in the turtle repository.</p>",
      );
      return;
    }
    const root = resolve(o.staticDir);
    let file = resolve(root, `.${normalize(decodeURIComponent(pathname))}`);
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, "not found");
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    // Client-side routes fall back to the app shell.
    if (!isFile) file = join(root, "index.html");
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes(`${sep}assets${sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  }

  /**
   * Loopback only. The Host check defeats DNS rebinding; requiring a custom header and a
   * JSON body on writes forces a CORS preflight, which this server never approves.
   */
  function checkHost(req: IncomingMessage): void {
    const host = req.headers.host ?? "";
    const i = host.lastIndexOf(":");
    const name = i > 0 && !host.endsWith("]") ? host.slice(0, i) : host;
    const p = i > 0 && !host.endsWith("]") ? Number(host.slice(i + 1)) : 80;
    if (!LOOPBACK.has(name) || p !== port) throw new HttpError(403, "forbidden host");
  }

  function checkMutation(req: IncomingMessage): void {
    if (req.headers["x-turtle"] !== "1") throw new HttpError(403, "missing x-turtle header");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
      throw new HttpError(415, "expected application/json");
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const u = new URL(origin);
        ok = LOOPBACK.has(u.hostname === "::1" ? "[::1]" : u.hostname) && Number(u.port) === port;
      } catch {}
      if (!ok) throw new HttpError(403, "forbidden origin");
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    Promise.resolve()
      .then(() => {
        checkHost(req);
        return route(req, res, url);
      })
      .catch((err: unknown) => {
        const status =
          err instanceof HttpError || err instanceof RouteError
            ? err.status
            : err instanceof OpsError
              ? 400
              : err instanceof RefConflictError
                ? 409
                : 500;
        if (status === 500) log(`error: ${(err as Error).stack ?? String(err)}`);
        if (res.headersSent) {
          res.end();
          return;
        }
        json(res, { error: (err as Error).message }, status);
      });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? 0, "127.0.0.1", () => {
      server.off("error", fail);
      ok();
    });
  });
  port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    sessions,
    close() {
      closing ??= (async () => {
        clearInterval(poll);
        clearInterval(reconcileTimer);
        clearInterval(heartbeat);
        const running = [...sessions.values()];
        for (const s of running) s.interrupt();
        await Promise.race([
          Promise.all(running.map((s) => s.done)),
          new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref()),
        ]);
        for (const c of clients) c.end();
        clients.clear();
        await new Promise<void>((r) => server.close(() => r()));
        server.closeAllConnections?.();
      })();
      return closing;
    },
  };
}

// ---------------------------------------------------------------- helpers

function json(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
