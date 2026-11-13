import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TurtleDb } from "../db/db.js";
import type { Agent, TurtleNode } from "../db/types.js";
import { GitStore } from "../git/store.js";
import type { Project } from "./project.js";
import type { Concept } from "./types.js";

/**
 * The Phase 2 gate (docs/phase2-spec.md §1, §15), measured passively from what turtle
 * recorded: G1 rewindable, G2 truthful, G3 shareable, G4 affordable, G5 reproducible
 * (hardening, architecture §3.7), plus redirect latency (recorded, not gated).
 */
export interface GateMetric {
  id: string;
  label: string;
  value: number | null;
  display: string;
  target?: string;
  /** null: reported only, or no data yet. */
  pass: boolean | null;
  detail?: string;
}

export interface GateGroup {
  id: "G1" | "G2" | "G3" | "G4" | "G5" | "latency";
  title: string;
  question: string;
  pass: boolean | null;
  metrics: GateMetric[];
}

export interface GateReport {
  at: string;
  project: string;
  groups: GateGroup[];
  /** True when every gated group passes. */
  pass: boolean | null;
}

/** A member's judgment of an export (G3). */
export interface ExportJudgment {
  conceptId: string;
  title: string;
  at: string;
  by: string;
  clear: { goal: boolean; results: boolean; decisions: boolean; openQuestions: boolean };
  redactions: number;
  leaks: string[];
  notes?: string;
}

/** The audit of one task's record against its tool log (G2). */
export interface TaskAudit {
  taskId: string;
  at: string;
  /** The task's version when audited; a newer version needs a new audit. */
  version: number;
  model: string;
  items: {
    id: string;
    kind: string;
    text: string;
    verdict: "supported" | "unsupported" | "contradicted";
    reason: string;
  }[];
  agreement: number;
  costUsd: number;
  /** The run cost of the task, for the audit's share of it. */
  runCostUsd: number;
}

// ------------------------------------------------------------------ storage

export function gateDir(project: Project): string {
  return join(project.turtleDir, "gate");
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJudgments(project: Project): Promise<ExportJudgment[]> {
  return readJson(join(gateDir(project), "exports.json"), [] as ExportJudgment[]);
}

export async function recordJudgment(project: Project, j: ExportJudgment): Promise<void> {
  const all = await readJudgments(project);
  all.push(j);
  await writeJson(join(gateDir(project), "exports.json"), all);
}

export async function readAudits(project: Project): Promise<Record<string, TaskAudit>> {
  return readJson(join(gateDir(project), "audits.json"), {} as Record<string, TaskAudit>);
}

export async function saveAudit(project: Project, a: TaskAudit): Promise<void> {
  const all = await readAudits(project);
  all[a.taskId] = a;
  await writeJson(join(gateDir(project), "audits.json"), all);
}

// ------------------------------------------------------------------ records

interface TaskRecord {
  task: Concept;
  agents: Agent[];
  nodes: TurtleNode[];
  /** Tool calls in order: name, input, result text. */
  tools: { name: string; input: Record<string, unknown>; result: string }[];
  assistantChars: number;
  costUsd: number;
}

/** Everything the sources recorded for each task's branches. */
export async function taskRecords(project: Project): Promise<Map<string, TaskRecord>> {
  const dbs = new Map<string, TurtleDb>();
  const out = new Map<string, TaskRecord>();
  try {
    for (const s of project.config.sources) {
      const store = await GitStore.open(s.path).catch(() => null);
      if (store) dbs.set(s.id, TurtleDb.open(join(store.turtleDir, "turtle.db")));
    }
    for (const task of project.db.listConcepts({ kind: "task" })) {
      const rec: TaskRecord = {
        task,
        agents: [],
        nodes: [],
        tools: [],
        assistantChars: 0,
        costUsd: 0,
      };
      for (const b of task.branches ?? []) {
        const db = dbs.get(b.source);
        if (!db) continue;
        const agents = db
          .listAgents({ branchId: b.branch })
          .filter((a) => a.adapter !== "companion");
        rec.agents.push(...agents);
        rec.nodes.push(...db.listNodes({ branchId: b.branch }));
        for (const a of agents) {
          rec.costUsd += a.totalCostUsd ?? 0;
          const names = new Map<string, number>();
          for (const m of db.listMessages(a.id)) {
            let msg: { message?: { content?: unknown } };
            try {
              msg = JSON.parse(m.json);
            } catch {
              continue;
            }
            const content = msg.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content as Record<string, unknown>[]) {
              if (block.type === "text" && m.type === "assistant")
                rec.assistantChars += String(block.text ?? "").length;
              else if (block.type === "tool_use") {
                names.set(String(block.id), rec.tools.length);
                rec.tools.push({
                  name: String(block.name),
                  input: (block.input ?? {}) as Record<string, unknown>,
                  result: "",
                });
              } else if (block.type === "tool_result") {
                const i = names.get(String(block.tool_use_id));
                const tool = i !== undefined ? rec.tools[i] : undefined;
                if (tool) tool.result = resultText(block.content);
              }
            }
          }
        }
      }
      out.set(task.id, rec);
    }
  } finally {
    for (const db of dbs.values()) db.close();
  }
  return out;
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((x) =>
        typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : "",
      )
      .join("\n");
  return c === undefined ? "" : JSON.stringify(c);
}

// ------------------------------------------------------------------ gate

const pct = (v: number | null) => (v === null ? "no data" : `${(v * 100).toFixed(0)}%`);
const ratio = (a: number, b: number) => (b ? a / b : null);

function metric(
  id: string,
  label: string,
  value: number | null,
  o: { target?: number; display?: string; detail?: string; lowerIsBetter?: boolean } = {},
): GateMetric {
  const pass =
    o.target === undefined || value === null
      ? null
      : o.lowerIsBetter
        ? value <= o.target
        : value >= o.target;
  return {
    id,
    label,
    value,
    display: o.display ?? pct(value),
    ...(o.target !== undefined
      ? { target: `${o.lowerIsBetter ? "≤" : "≥"} ${(o.target * 100).toFixed(0)}%` }
      : {}),
    pass,
    ...(o.detail ? { detail: o.detail } : {}),
  };
}

function groupPass(metrics: GateMetric[]): boolean | null {
  const gated = metrics.filter((m) => m.target !== undefined);
  if (!gated.length || gated.some((m) => m.pass === null)) return null;
  return gated.every((m) => m.pass);
}

const tokensOf = (n: TurtleNode) =>
  n.tokens.input + n.tokens.output + n.tokens.cacheRead + n.tokens.cacheWrite;

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null;
}

/** Compute the gate report from the project and its sources. */
export async function computeGate(project: Project): Promise<GateReport> {
  const recs = await taskRecords(project);
  const tasks = [...recs.values()].filter((r) => !r.task.dropped);
  const live = project.db.listConcepts();
  const groups: GateGroup[] = [];

  // G1 — rewindable
  const modelNodes = tasks.flatMap((r) => {
    const recipeAgents = new Set(r.agents.filter((a) => a.model === "recipe").map((a) => a.id));
    return r.nodes.filter(
      (n) =>
        n.kind === "semantic" &&
        n.summarySource === "agent_declared" &&
        !(n.agentId && recipeAgents.has(n.agentId)),
    );
  });
  const resumable = modelNodes.filter((n) => n.sessionId && n.resumeMessageUuid).length;
  const forked = tasks.filter((r) => r.task.startFrom && r.agents.length);
  const forkOk = forked.filter((r) => {
    const first = [...r.agents].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    return first && first.status !== "failed";
  }).length;
  const g1 = [
    metric(
      "g1.resumable",
      "Declared checkpoints with a resume point",
      ratio(resumable, modelNodes.length),
      {
        target: 0.95,
        detail: `${resumable} of ${modelNodes.length}`,
      },
    ),
    metric(
      "g1.forks",
      "Runs started from a checkpoint that succeed",
      ratio(forkOk, forked.length),
      {
        target: 0.9,
        detail: `${forkOk} of ${forked.length} (new task from here, retries, replays)`,
      },
    ),
  ];
  groups.push({
    id: "G1",
    title: "Rewindable",
    question: "Can work restart from any point?",
    pass: groupPass(g1),
    metrics: g1,
  });

  // G2 — truthful
  const findings = live.filter((c) => c.kind === "finding" && !c.dropped);
  const evidenced = findings.filter((f) =>
    project.db.listLinks({ from: f.id, rel: "evidence" }).some((l) => !l.removed),
  ).length;
  const done = tasks.filter((r) => r.task.status === "done");
  const doneWithCp = done.filter((r) =>
    project.db.listLinks({ from: r.task.id, rel: "evidence" }).some((l) => l.to.type === "node"),
  ).length;
  const audits = await readAudits(project);
  const auditable = tasks.filter(
    (r) =>
      ["done", "blocked", "failed", "need_decision", "abandoned"].includes(r.task.status ?? "") &&
      r.agents.length,
  );
  const audited = auditable.map((r) => audits[r.task.id]).filter((a): a is TaskAudit => !!a);
  const items = audited.flatMap((a) => a.items);
  const supported = items.filter((i) => i.verdict === "supported").length;
  const contradicted = items.filter((i) => i.verdict === "contradicted").length;
  const auditCost = audited.reduce((s, a) => s + a.costUsd, 0);
  const auditedRunCost = audited.reduce((s, a) => s + a.runCostUsd, 0);
  const g2 = [
    metric("g2.findings", "Findings with evidence", ratio(evidenced, findings.length), {
      target: 0.9,
      detail: `${evidenced} of ${findings.length}`,
    }),
    metric("g2.done", "Done tasks with a checkpoint", ratio(doneWithCp, done.length), {
      target: 0.9,
      detail: `${doneWithCp} of ${done.length}`,
    }),
    metric("g2.audit", "Audit agreement (record vs tool log)", ratio(supported, items.length), {
      target: 0.85,
      detail: `${supported} supported, ${contradicted} contradicted, of ${items.length} items in ${audited.length} of ${auditable.length} finished tasks${audited.length < auditable.length ? " (run turtle audit for the rest)" : ""}`,
    }),
    metric("g2.audit_cost", "Audit cost, share of run cost", ratio(auditCost, auditedRunCost), {
      target: 0.03,
      lowerIsBetter: true,
      detail: `$${auditCost.toFixed(4)} for $${auditedRunCost.toFixed(2)} of runs`,
    }),
  ];
  groups.push({
    id: "G2",
    title: "Truthful",
    question: "Does the graph match what happened?",
    pass: groupPass(g2),
    metrics: g2,
  });

  // G3 — shareable
  const judgments = await readJudgments(project);
  const latest = new Map<string, ExportJudgment>();
  for (const j of judgments) latest.set(j.conceptId, j);
  const judged = [...latest.values()];
  const clear = judged.filter((j) => Object.values(j.clear).every(Boolean)).length;
  const leaks = judged.reduce((s, j) => s + j.leaks.length, 0);
  const g3: GateMetric[] = [
    {
      id: "g3.judged",
      label: "Exports judged clear (goal, results, decisions, open questions)",
      value: judged.length,
      display: `${clear} of ${judged.length}`,
      target: "3 of 3",
      pass: judged.length < 3 ? null : clear === judged.length,
      detail: judged.length < 3 ? `judge ${3 - judged.length} more export(s)` : "",
    },
    {
      id: "g3.leaks",
      label: "Secrets or home paths left in exports",
      value: leaks,
      display: String(leaks),
      target: "0",
      pass: judged.length ? leaks === 0 : null,
    },
  ];
  groups.push({
    id: "G3",
    title: "Shareable",
    question: "Does an export stand on its own?",
    pass: groupPass(g3),
    metrics: g3,
  });

  // G4 — affordable (reported; graph tools < 5 %)
  const doneTokens = done.map((r) => r.nodes.reduce((s, n) => s + tokensOf(n), 0));
  const allCost = tasks.reduce((s, r) => s + r.costUsd, 0);
  let toolChars = 0;
  let turtleChars = 0;
  for (const r of tasks) {
    toolChars += r.assistantChars;
    for (const t of r.tools) {
      const n = JSON.stringify(t.input).length + t.result.length;
      toolChars += n;
      if (t.name.startsWith("mcp__turtle__")) turtleChars += n;
    }
  }
  const withDeps = tasks.filter((r) => (r.task.dependsOn ?? []).length && r.tools.length);
  const cmds = (r: TaskRecord) =>
    new Set(
      r.tools
        .filter((t) => t.name === "Bash" && typeof t.input.command === "string")
        .map((t) => String(t.input.command).trim())
        .filter((c) => c.length >= 12),
    );
  const repeated = withDeps.filter((r) => {
    const mine = cmds(r);
    return (r.task.dependsOn ?? []).some((d) => {
      const dep = recs.get(d);
      return dep ? [...cmds(dep)].some((c) => mine.has(c)) : false;
    });
  }).length;
  const median = percentile(doneTokens, 0.5);
  const g4 = [
    {
      id: "g4.tokens",
      label: "Tokens per finished task (median)",
      value: median,
      display: median === null ? "no data" : `${Math.round(median).toLocaleString("en")}`,
      pass: null,
      detail: `${done.length} done tasks; $${allCost.toFixed(2)} spent on all task runs`,
    },
    metric(
      "g4.graph_share",
      "Share of the conversation spent on turtle tools (estimate)",
      ratio(turtleChars, toolChars),
      {
        target: 0.05,
        lowerIsBetter: true,
        detail: "by characters of tool inputs, results and agent text",
      },
    ),
    metric(
      "g4.repeated",
      "Tasks that re-ran a command of a task they depend on",
      ratio(repeated, withDeps.length),
      {
        detail: `${repeated} of ${withDeps.length}`,
      },
    ),
  ];
  groups.push({
    id: "G4",
    title: "Affordable",
    question: "What does the record cost?",
    pass: groupPass(g4),
    metrics: g4,
  });

  // G5 — reproducible (hardening, reported)
  const recipes = live.filter((c) => c.kind === "recipe" && !c.dropped);
  const verified = recipes.filter((c) => c.recipeState === "verified").length;
  const replays = tasks.filter((r) => r.task.replay?.result);
  const noModel = replays.filter((r) => r.task.replay?.result?.ok).length;
  const repaired = replays.filter(
    (r) => !r.task.replay?.result?.ok && r.task.status === "done",
  ).length;
  const activeChecks = live.filter(
    (c) => c.kind === "check" && !c.dropped && (c.checkState ?? "active") === "active",
  ).length;
  const failedEver = new Set<string>();
  for (const op of project.db.listOps()) {
    const ch = op.change;
    if (ch.kind !== "set" || !ch.fields.checkResults) continue;
    for (const [checkId, res] of Object.entries(ch.fields.checkResults))
      if (!res.ok) failedEver.add(`${ch.id}|${checkId}`);
  }
  const fixed = [...failedEver].filter((k) => {
    const [taskId, checkId] = k.split("|") as [string, string];
    return project.getConcept(taskId)?.checkResults?.[checkId]?.ok;
  }).length;
  const g5: GateMetric[] = [
    metric("g5.recipes", "Recipes verified by a clean replay", ratio(verified, recipes.length), {
      detail: `${verified} of ${recipes.length}`,
    }),
    metric("g5.replays", "Replays that needed no model", ratio(noModel, replays.length), {
      detail: `${noModel} of ${replays.length}; ${repaired} repaired by an agent`,
    }),
    {
      id: "g5.checks",
      label: "Check failures caught, then fixed",
      value: failedEver.size,
      display: `${fixed} of ${failedEver.size}`,
      pass: null,
      detail: `${activeChecks} active checks`,
    },
  ];
  groups.push({
    id: "G5",
    title: "Reproducible",
    question: "Do hardened steps redo themselves?",
    pass: null,
    metrics: g5,
  });

  // Redirect latency (recorded, not gated)
  const lat: number[] = [];
  for (const s of project.config.sources) {
    const store = await GitStore.open(s.path).catch(() => null);
    if (!store) continue;
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    try {
      const queued = new Map(db.listEvents({ type: "instruction" }).map((e) => [e.seq, e.at]));
      for (const e of db.listEvents({ type: "instruction_delivered" }))
        for (const seq of (e.payload.seqs ?? []) as number[]) {
          const at = queued.get(seq);
          if (at) lat.push(Date.parse(e.at) - Date.parse(at));
        }
    } finally {
      db.close();
    }
  }
  const p50 = percentile(lat, 0.5);
  const p95 = percentile(lat, 0.95);
  const fmtMs = (v: number | null) => (v === null ? "no data" : `${(v / 1000).toFixed(1)} s`);
  groups.push({
    id: "latency",
    title: "Redirect latency",
    question: "How long until a message reaches a running agent?",
    pass: null,
    metrics: [
      {
        id: "lat.p50",
        label: "p50",
        value: p50,
        display: fmtMs(p50),
        pass: null,
        detail: `${lat.length} delivered`,
      },
      { id: "lat.p95", label: "p95", value: p95, display: fmtMs(p95), pass: null },
    ],
  });

  const gated = groups.filter((g) => ["G1", "G2", "G3", "G4"].includes(g.id));
  const pass = gated.some((g) => g.pass === false)
    ? false
    : gated.every((g) => g.pass === true)
      ? true
      : null;
  return { at: new Date().toISOString(), project: project.config.name, groups, pass };
}
