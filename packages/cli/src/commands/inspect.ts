import type { TurtleDb, TurtleNode } from "@turtle/core";
import { type Context, resolveBranch, resolveNode, shortIds } from "../context.js";
import {
  ago,
  c,
  firstLine,
  money,
  nodeLine,
  percentile,
  statusColor,
  truncate,
} from "../render.js";

// -------------------------------------------------------------------- log

/**
 * Tree of nodes across all branches. Linear history stays in one column; each fork
 * opens a new column (├─ / └─). Micro snapshots are hidden unless `all`.
 */
export function logCommand(ctx: Context, o: { all?: boolean; branch?: string }): string[] {
  const { db } = ctx;
  const short = shortIds(db);
  let nodes = db.listNodes();
  if (o.branch) {
    const b = resolveBranch(ctx.db, o.branch) ?? undefined;
    const keep = new Set(ancestry(db, b?.headNodeId ?? ""));
    nodes = nodes.filter((n) => keep.has(n.id));
  }
  const visible = (n: TurtleNode) => o.all || n.kind !== "micro";
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shown = nodes.filter(visible);
  const shownIds = new Set(shown.map((n) => n.id));

  // Parent in the displayed tree = nearest displayed ancestor.
  const displayParent = new Map<string, string | null>();
  const hiddenBelow = new Map<string, number>();
  const nearestShown = (id: string | undefined): string | null => {
    let cur = id ? byId.get(id) : undefined;
    while (cur && !shownIds.has(cur.id)) {
      hiddenBelow.set(cur.id, 1);
      cur = cur.parents[0] ? byId.get(cur.parents[0]) : undefined;
    }
    return cur?.id ?? null;
  };
  for (const n of shown) displayParent.set(n.id, nearestShown(n.parents[0]));
  const children = new Map<string, TurtleNode[]>();
  const roots: TurtleNode[] = [];
  for (const n of shown) {
    const p = displayParent.get(n.id);
    if (p) children.set(p, [...(children.get(p) ?? []), n]);
    else roots.push(n);
  }

  // Branch heads: label the nearest displayed ancestor of each head.
  const labels = new Map<string, string[]>();
  for (const b of db.listBranches()) {
    if (!b.headNodeId || !byId.has(b.headNodeId)) continue;
    const at = shownIds.has(b.headNodeId) ? b.headNodeId : nearestShown(b.headNodeId);
    if (!at) continue;
    const pending = at === b.headNodeId ? "" : c.dim(" +micro");
    const name = b.name ? `${b.name} ` : "";
    const label = `${c.magenta(`← ${name}${short(b.id)}`)} ${statusColor(b.status)(b.status)}${pending}`;
    labels.set(at, [...(labels.get(at) ?? []), label]);
  }

  const out: string[] = [];
  const render = (start: TurtleNode, first: string, rest: string) => {
    let n: TurtleNode | undefined = start;
    let prefix = first;
    while (n) {
      const label = labels.get(n.id)?.join(" ") ?? "";
      out.push(`${c.dim(prefix)}${nodeLine(n, short)}${label ? `  ${label}` : ""}`);
      prefix = rest;
      const kids: TurtleNode[] = children.get(n.id) ?? [];
      if (kids.length === 1) {
        n = kids[0];
        continue;
      }
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        render(kid, `${rest}${last ? "└─" : "├─"}`, `${rest}${last ? "  " : "│ "}`);
      });
      n = undefined;
    }
  };
  for (const r of roots) render(r, "", "");
  if (out.length === 0) out.push(c.dim('no history yet — start with: turtle run "<task>"'));
  return out;
}

function ancestry(db: TurtleDb, nodeId: string): string[] {
  const ids: string[] = [];
  let cur = db.getNode(nodeId);
  while (cur) {
    ids.push(cur.id);
    cur = cur.parents[0] ? db.getNode(cur.parents[0]) : null;
  }
  return ids;
}

// ------------------------------------------------------------------- show

export async function showCommand(
  ctx: Context,
  ref: string,
  o: { diff?: boolean; transcript?: boolean; artifacts?: boolean },
): Promise<string[]> {
  const { db, store } = ctx;
  const n = resolveNode(db, ref);
  const short = shortIds(db);
  const out: string[] = [];
  const branch = db.getBranch(n.branchId);
  const agent = n.agentId ? db.getAgent(n.agentId) : null;
  out.push(`${c.bold(`node ${n.id}`)}  ${n.kind}  ${statusColor(n.status)(n.status)}`);
  out.push(
    `branch   ${short(n.branchId)}${branch?.name ? ` (${branch.name})` : ""}  ${branch?.status ?? ""}`,
  );
  out.push(`created  ${n.createdAt}  (${ago(n.createdAt)})`);
  out.push(
    `trigger  ${n.trigger ?? "—"}${n.summarySource ? `  summary by ${n.summarySource}` : ""}`,
  );
  out.push(`parents  ${n.parents.map(short).join(", ") || "—"}`);
  const kids = db.childrenOf(n.id);
  if (kids.length)
    out.push(
      `children ${kids.map((k) => `${short(k.id)}${k.kind === "micro" ? "·" : ""}`).join(", ")}`,
    );
  out.push(`commit   ${n.commitSha}`);
  out.push(
    `changes  ${n.kind === "semantic" ? "since last checkpoint: " : ""}${n.filesChanged ?? 0} files  +${n.linesAdded ?? 0} −${n.linesDeleted ?? 0}${n.tests ? `  tests ${n.tests}` : ""}`,
  );
  const t = n.tokens;
  out.push(
    `tokens   in ${t.input}  out ${t.output}  cache-read ${t.cacheRead}  cache-write ${t.cacheWrite}  est ${money(n.costUsdEst)}`,
  );
  if (agent)
    out.push(
      `agent    ${agent.id}  ${agent.model ?? ""}  ${agent.status}  session ${agent.sessionId ?? "—"}`,
    );
  out.push(
    `resume   ${n.resumeMessageUuid ? `at ${n.resumeMessageUuid}` : "no resume point (fork adds summaries)"}`,
  );
  if (n.intent) out.push(`intent   ${truncate(firstLine(n.intent), 100)}`);
  out.push("", ...(n.summary ?? "").split("\n").map((l) => `    ${l}`));

  const artifacts = db.listArtifacts(n.id);
  if (artifacts.length || o.artifacts) {
    out.push("", c.bold("artifacts"));
    for (const a of artifacts)
      out.push(
        `  ${a.label ?? a.path}  ${a.path ?? ""}  ${a.size ?? 0}B  blob ${a.blobSha.slice(0, 12)}`,
      );
    if (!artifacts.length) out.push(c.dim("  (none)"));
  }

  if (o.diff) {
    // Semantic nodes diff against the previous checkpoint; others against their parent.
    let parent = n.parents[0] ? db.getNode(n.parents[0]) : null;
    if (n.kind === "semantic") {
      while (parent && parent.kind === "micro")
        parent = parent.parents[0] ? db.getNode(parent.parents[0]) : null;
    }
    const fromTree = parent?.treeSha ?? (await store.emptyTree());
    out.push(
      "",
      c.bold(`diff vs ${parent ? `${short(parent.id)} (${parent.kind})` : "empty tree"}`),
    );
    const diff = await store.diff(fromTree, n.treeSha);
    out.push(diff ? colorDiff(diff) : c.dim("(no changes)"));
  }

  if (o.transcript && n.agentId) {
    out.push("", c.bold("transcript (messages leading to this node)"));
    for (const m of db.listMessages(n.agentId, { nodeId: n.id }))
      out.push(...describeMessage(m.json));
  }
  return out;
}

function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((l) =>
      l.startsWith("+") && !l.startsWith("+++")
        ? c.green(l)
        : l.startsWith("-") && !l.startsWith("---")
          ? c.red(l)
          : l.startsWith("@@")
            ? c.cyan(l)
            : l,
    )
    .join("\n");
}

function describeMessage(json: string): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: SDK messages are untyped JSON.
  const m = JSON.parse(json) as any;
  const sub = m.parent_tool_use_id ? c.dim("  (subagent)") : "";
  if (m.type === "system") return [c.dim(`  [system ${m.subtype}] model ${m.model ?? ""}`)];
  if (m.type === "result")
    return [c.dim(`  [result ${m.subtype}] cost ${money(m.total_cost_usd)}`)];
  const blocks = Array.isArray(m.message?.content)
    ? m.message.content
    : [{ type: "text", text: String(m.message?.content ?? "") }];
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text)
      out.push(
        `  ${m.type === "assistant" ? "assistant" : "user"}: ${truncate(b.text.replace(/\s+/g, " "), 200)}${sub}`,
      );
    else if (b.type === "tool_use")
      out.push(c.cyan(`  → ${b.name} ${truncate(JSON.stringify(b.input), 150)}${sub}`));
    else if (b.type === "tool_result") {
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      out.push(c.dim(`  ← ${truncate(text.replace(/\s+/g, " "), 150)}${sub}`));
    }
  }
  return out;
}

// ----------------------------------------------------------------- status

export function statusCommand(ctx: Context): string[] {
  const { db } = ctx;
  const short = shortIds(db);
  const out: string[] = [];
  const running = db.listAgents({ status: "running" });
  out.push(c.bold(`running (${running.length})`));
  for (const a of running) {
    const head = db.getBranch(a.branchId)?.headNodeId;
    out.push(
      `  ${short(a.branchId)}  agent ${a.id.slice(0, 6)}  started ${ago(a.startedAt)}  head ${head ? short(head) : "—"}  ${truncate(firstLine(a.prompt), 50)}`,
    );
  }
  if (!running.length) out.push(c.dim("  (none)"));

  const attention: string[] = [];
  for (const b of db.listBranches()) {
    if (b.status === "running" || !b.headNodeId) continue;
    let n = db.getNode(b.headNodeId);
    while (n && n.kind === "micro") n = n.parents[0] ? db.getNode(n.parents[0]) : null;
    if (n && (n.status === "need_decision" || n.status === "blocked")) {
      attention.push(
        `  ${statusColor(n.status)(n.status.padEnd(14))} ${c.bold(short(n.id))}  ${truncate(firstLine(n.summary), 60)}  ${c.dim(`[${short(b.id)}]`)}`,
      );
      attention.push(c.dim(`      turtle run --from ${short(n.id)} "<answer>"`));
    }
  }
  out.push(
    "",
    c.bold(`needs you (${attention.length / 2})`),
    ...(attention.length ? attention : [c.dim("  (nothing)")]),
  );

  const recent = db.listBranches().slice(-10).reverse();
  out.push("", c.bold("recent branches"));
  for (const b of recent) {
    const head = b.headNodeId ? db.getNode(b.headNodeId) : null;
    out.push(
      `  ${short(b.id)}  ${statusColor(b.status)(b.status.padEnd(8))} ${ago(b.updatedAt).padEnd(8)} ${truncate(firstLine(head?.summary), 60)}`,
    );
  }
  if (!recent.length) out.push(c.dim("  (none)"));
  return out;
}

// ------------------------------------------------------------------ stats

export interface RunStats {
  agentId: string;
  branchId: string;
  status: string;
  durationMin: number;
  micro: number;
  declared: number;
  auto: number;
  toolCalls: number;
  snapshotMs: number[];
  runCostUsd: number | null;
  summarizerCostUsd: number;
}

export function collectStats(db: TurtleDb): RunStats[] {
  return db.listAgents().map((a) => {
    const nodes = db.listNodes({ branchId: a.branchId }).filter((n) => n.agentId === a.id);
    const events = db.listEvents({ agentId: a.id });
    const checkpoints = events.filter((e) => e.type === "checkpoint");
    const summarizerCostUsd = checkpoints.reduce((sum, e) => {
      const s = e.payload.summarizer as { costUsd?: number } | undefined;
      return sum + (s?.costUsd ?? 0);
    }, 0);
    const end = a.endedAt ? Date.parse(a.endedAt) : Date.now();
    return {
      agentId: a.id,
      branchId: a.branchId,
      status: a.status,
      durationMin: (end - Date.parse(a.startedAt)) / 60_000,
      micro: nodes.filter((n) => n.kind === "micro").length,
      declared: nodes.filter((n) => n.kind === "semantic" && n.summarySource === "agent_declared")
        .length,
      auto: nodes.filter((n) => n.kind === "semantic" && n.summarySource === "rule_auto").length,
      toolCalls: events.filter((e) => e.type === "tool_call").length,
      snapshotMs: checkpoints.map((e) => Number(e.payload.snapshotMs)).filter(Number.isFinite),
      runCostUsd: a.totalCostUsd,
      summarizerCostUsd,
    };
  });
}

export function statsCommand(
  ctx: Context,
  o: { criteria?: boolean },
): { lines: string[]; ok: boolean } {
  const { db } = ctx;
  const short = shortIds(db);
  const stats = collectStats(db);
  const out: string[] = [
    c.bold(
      "run        branch  status   min    tools  micro  declared  auto  snap p95  cost      summarizer",
    ),
  ];
  for (const s of stats) {
    out.push(
      [
        s.agentId.slice(0, 8).padEnd(10),
        short(s.branchId).padEnd(7),
        s.status.padEnd(8),
        s.durationMin.toFixed(1).padStart(5),
        String(s.toolCalls).padStart(6),
        String(s.micro).padStart(6),
        String(s.declared).padStart(9),
        String(s.auto).padStart(5),
        `${percentile(s.snapshotMs, 95) ?? "—"}ms`.padStart(9),
        money(s.runCostUsd).padStart(9),
        money(s.summarizerCostUsd).padStart(11),
      ].join(" "),
    );
  }
  if (!stats.length) out.push(c.dim("(no runs yet)"));
  if (!o.criteria) return { lines: out, ok: true };

  const finished = stats.filter((s) => s.status === "done" || s.status === "killed");
  const allSnaps = stats.flatMap((s) => s.snapshotMs);
  const p95 = percentile(allSnaps, 95);
  const longRuns = finished.filter((s) => s.durationMin >= 30);
  const perHour = longRuns.map((s) => ((s.declared + s.auto) / s.durationMin) * 60);
  const runCost = finished.reduce((sum, s) => sum + (s.runCostUsd ?? 0), 0);
  const sumCost = finished.reduce((sum, s) => sum + s.summarizerCostUsd, 0);
  const forks = db.listEvents({ type: "fork" }).filter((e) => e.payload.resumed === true);
  const forkOk = forks.some((e) => db.getAgent(e.agentId ?? "")?.status === "done");
  const criteria: [string, boolean | null, string][] = [
    ["E1 ≥5 real runs finished", finished.length >= 5, `${finished.length} finished`],
    [
      "E2 3–15 semantic checkpoints per hour (runs ≥30 min)",
      perHour.length ? perHour.every((r) => r >= 3 && r <= 15) : null,
      perHour.length ? perHour.map((r) => r.toFixed(1)).join(", ") : "no runs ≥30 min yet",
    ],
    [
      "E3 snapshot p95 < 300 ms",
      p95 === null ? null : p95 < 300,
      p95 === null ? "no snapshots" : `${p95} ms`,
    ],
    [
      "E4 summarizer overhead < 5% of run cost",
      runCost > 0 ? sumCost / runCost < 0.05 : null,
      runCost > 0 ? `${((sumCost / runCost) * 100).toFixed(1)}%` : "no cost data",
    ],
    [
      "E5 fork from a mid-run node resumed and finished",
      forks.length ? forkOk : null,
      `${forks.length} resumed forks`,
    ],
    ["E6 consistency", null, "run `turtle doctor`"],
  ];
  out.push("", c.bold("exit criteria"));
  for (const [name, pass, detail] of criteria) {
    const mark = pass === null ? c.dim("  ?  ") : pass ? c.green(" PASS") : c.red(" FAIL");
    out.push(`${mark} ${name}  ${c.dim(detail)}`);
  }
  return { lines: out, ok: criteria.every(([, pass]) => pass !== false) };
}
