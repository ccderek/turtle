import { basename } from "node:path";
import type { Agent, StoredMessage, TurtleConfig, TurtleDb, TurtleNode } from "@turtle/core";
import type {
  AgentView,
  AttentionItem,
  BranchView,
  NodeView,
  StateResponse,
  TranscriptItem,
} from "./api.js";

const BUDGET_WARN = 0.8;
const TOOL_INPUT_CHARS = 2_000;
const TOOL_RESULT_CHARS = 4_000;

const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0] ?? "";

/** Everything the UI's main screen needs, computed from the DB in one pass. */
export class StateBuilder {
  constructor(
    private readonly db: TurtleDb,
    private readonly config: TurtleConfig,
    private readonly repoRoot: string,
    private readonly ownedAgents: () => ReadonlySet<string>,
  ) {}

  nodesById(): Map<string, TurtleNode> {
    return new Map(this.db.listNodes().map((n) => [n.id, n]));
  }

  agentViews(byId = this.nodesById()): AgentView[] {
    const budgets = new Map<string, number | null>();
    for (const type of ["run_start", "fork"]) {
      for (const e of this.db.listEvents({ type })) {
        if (!e.agentId) continue;
        const b = e.payload.maxBudgetUsd;
        budgets.set(e.agentId, typeof b === "number" ? b : null);
      }
    }
    const estimate = new Map<string, number>();
    for (const n of byId.values()) {
      if (n.agentId) estimate.set(n.agentId, (estimate.get(n.agentId) ?? 0) + n.costUsdEst);
    }
    const owned = this.ownedAgents();
    return this.db.listAgents().map((a) => this.agentView(a, estimate, budgets, owned));
  }

  private agentView(
    a: Agent,
    estimate: Map<string, number>,
    budgets: Map<string, number | null>,
    owned: ReadonlySet<string>,
  ): AgentView {
    return {
      ...a,
      costUsd: a.totalCostUsd ?? estimate.get(a.id) ?? 0,
      maxBudgetUsd: budgets.get(a.id) ?? this.config.agent.maxBudgetUsd ?? null,
      ownedByUi: owned.has(a.id),
    };
  }

  agentView1(agentId: string): AgentView | null {
    return this.agentViews().find((a) => a.id === agentId) ?? null;
  }

  state(o: { micro?: boolean } = {}): StateResponse {
    const db = this.db;
    const byId = this.nodesById();
    const agents = this.agentViews(byId);
    const branches = this.branchViews(byId, agents);
    const nodes = nodeViews([...byId.values()], o.micro ?? false);
    let micro = 0;
    for (const n of byId.values()) if (n.kind === "micro") micro++;
    return {
      repo: { root: this.repoRoot, name: basename(this.repoRoot) },
      defaults: {
        sandbox: this.config.sandbox.mode,
        model: this.config.agent.model ?? null,
        maxBudgetUsd: this.config.agent.maxBudgetUsd ?? null,
      },
      branches,
      agents,
      nodes,
      snapshots: db.listSnapshots(),
      attention: attention(branches, agents, byId),
      totals: {
        costUsd: agents.reduce((s, a) => s + a.costUsd, 0),
        running: agents.filter((a) => a.status === "running" || a.status === "starting").length,
        nodes: byId.size,
        micro,
      },
    };
  }

  branchViews(byId = this.nodesById(), agents = this.agentViews(byId)): BranchView[] {
    const errors = new Map<string, string | null>();
    for (const e of this.db.listEvents({ type: "run_end" })) {
      if (!e.branchId) continue;
      const err = e.payload.error;
      errors.set(e.branchId, typeof err === "string" ? err : null);
    }
    return this.db.listBranches().map((b) => {
      let head = b.headNodeId ? byId.get(b.headNodeId) : undefined;
      let pending = 0;
      while (head && head.kind === "micro") {
        pending++;
        head = head.parents[0] ? byId.get(head.parents[0]) : undefined;
      }
      return {
        ...b,
        checkpointHeadId: head?.id ?? null,
        pendingSteps: pending,
        costUsd: agents.filter((a) => a.branchId === b.id).reduce((s, a) => s + a.costUsd, 0),
        lastError: b.status === "failed" ? (errors.get(b.id) ?? null) : null,
      };
    });
  }

  nodeView(id: string, byId = this.nodesById()): NodeView | null {
    const n = byId.get(id);
    if (!n) return null;
    // Detail views show micro nodes too, so their display parent is the real parent.
    if (n.kind === "micro") return { ...n, displayParent: n.parents[0] ?? null, hiddenSteps: 0 };
    let hidden = 0;
    let p = n.parents[0] ? byId.get(n.parents[0]) : undefined;
    while (p && p.kind === "micro") {
      hidden++;
      p = p.parents[0] ? byId.get(p.parents[0]) : undefined;
    }
    return { ...n, displayParent: p?.id ?? null, hiddenSteps: hidden };
  }
}

/** Nodes for the tree; with `micro` false, micro snapshots are folded into hiddenSteps. */
export function nodeViews(all: TurtleNode[], micro: boolean): NodeView[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  const out: NodeView[] = [];
  for (const n of all) {
    if (!micro && n.kind === "micro") continue;
    let hidden = 0;
    let p = n.parents[0] ? byId.get(n.parents[0]) : undefined;
    while (!micro && p && p.kind === "micro") {
      hidden++;
      p = p.parents[0] ? byId.get(p.parents[0]) : undefined;
    }
    out.push({ ...n, displayParent: p?.id ?? null, hiddenSteps: hidden });
  }
  return out;
}

/** What needs a human, newest first (docs/architecture.md §6 "UI principles"). */
export function attention(
  branches: BranchView[],
  agents: AgentView[],
  byId: Map<string, TurtleNode>,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const b of branches) {
    const cp = b.checkpointHeadId ? byId.get(b.checkpointHeadId) : undefined;
    const head = b.headNodeId ? byId.get(b.headNodeId) : undefined;
    const base = {
      branchId: b.id,
      nodeId: cp?.id ?? null,
      headNodeId: b.headNodeId,
      agentId: null,
    };
    if (b.status === "idle" && cp && (cp.status === "need_decision" || cp.status === "blocked")) {
      items.push({
        ...base,
        id: `${cp.status}:${cp.id}`,
        kind: cp.status,
        title: firstLine(cp.summary) || cp.status,
        detail: cp.summary?.includes("\n")
          ? cp.summary.slice(cp.summary.indexOf("\n") + 1).trim()
          : null,
        at: cp.createdAt,
      });
    } else if (b.status === "failed") {
      items.push({
        ...base,
        id: `failed:${b.id}:${b.updatedAt}`,
        kind: "failed",
        title: "Run failed",
        detail: b.lastError,
        at: b.updatedAt,
      });
    } else if (b.status === "running" && head?.tests === "fail") {
      items.push({
        ...base,
        id: `tests:${b.id}`,
        kind: "tests_failing",
        title: "Tests are failing",
        detail: firstLine(cp?.summary) || null,
        at: head.createdAt,
      });
    }
  }
  for (const a of agents) {
    if (a.status !== "running" || !a.maxBudgetUsd) continue;
    if (a.costUsd >= a.maxBudgetUsd * BUDGET_WARN) {
      items.push({
        id: `budget:${a.id}`,
        kind: "budget",
        branchId: a.branchId,
        nodeId: null,
        headNodeId: null,
        agentId: a.id,
        title: `Budget ${Math.round((a.costUsd / a.maxBudgetUsd) * 100)}% used`,
        detail: `$${a.costUsd.toFixed(2)} of $${a.maxBudgetUsd.toFixed(2)}`,
        at: a.startedAt,
      });
    }
  }
  return items.sort((x, y) => y.at.localeCompare(x.at));
}

// ------------------------------------------------------------- transcript

/** Flatten stored SDK messages into display items (text is truncated for the browser). */
export function transcriptItems(messages: StoredMessage[], prompt?: string): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const m of messages) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK messages are untyped JSON.
    let j: any;
    try {
      j = JSON.parse(m.json);
    } catch {
      continue;
    }
    const base = {
      agentId: m.agentId,
      seq: m.seq,
      nodeId: m.nodeId,
      sub: Boolean(m.parentToolUseId),
    };
    if (j.type === "system") {
      out.push({
        ...base,
        kind: "system",
        text: j.subtype === "init" ? `session started · ${j.model ?? ""}` : String(j.subtype),
      });
      continue;
    }
    if (j.type === "result") {
      out.push({
        ...base,
        kind: "result",
        subtype: String(j.subtype ?? ""),
        costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
        numTurns: typeof j.num_turns === "number" ? j.num_turns : null,
      });
      continue;
    }
    const content = j.message?.content;
    const blocks = Array.isArray(content)
      ? content
      : [{ type: "text", text: String(content ?? "") }];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (j.type === "user") {
          // The SDK may echo the prompt (possibly with turtle's context prefix) back.
          if (prompt && b.text.trim().endsWith(prompt.trim())) continue;
          out.push({ ...base, kind: "user", text: b.text });
        } else out.push({ ...base, kind: "text", text: b.text });
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        out.push({ ...base, kind: "thinking", text: b.thinking });
      } else if (b?.type === "tool_use") {
        out.push({
          ...base,
          kind: "tool_use",
          id: String(b.id),
          name: String(b.name),
          summary: toolSummary(b.input),
          input: clip(JSON.stringify(b.input ?? {}, null, 2), TOOL_INPUT_CHARS),
        });
      } else if (b?.type === "tool_result") {
        out.push({
          ...base,
          kind: "tool_result",
          toolUseId: String(b.tool_use_id),
          text: clip(resultText(b.content), TOOL_RESULT_CHARS),
          isError: Boolean(b.is_error),
        });
      }
    }
  }
  return out;
}

/** One line describing a tool call: its path, command, pattern, url or checkpoint summary. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const key of [
    "summary",
    "file_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
  ]) {
    const v = i[key];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]?.slice(0, 200) ?? "";
  }
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s.slice(0, 200);
}

// biome-ignore lint/suspicious/noExplicitAny: SDK content blocks are untyped JSON.
function resultText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" ? String(c.text) : c?.type === "image" ? "[image]" : ""))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}
