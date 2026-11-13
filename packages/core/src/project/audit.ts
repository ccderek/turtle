import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ModelPrice } from "../config.js";
import { estimateCost, priceFor } from "../run/usage.js";
import { readAudits, saveAudit, type TaskAudit, taskRecords } from "./gate.js";
import type { Project } from "./project.js";
import type { Concept } from "./types.js";

/** A client with the credentials in the environment (ANTHROPIC_API_KEY, …). */
export function anthropicClient(): Anthropic {
  return new Anthropic();
}

/** Whether the environment has credentials for the API (not the agent's OAuth token). */
export function hasApiCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

const AuditSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().describe("The item's id, exactly as given."),
      verdict: z.enum(["supported", "unsupported", "contradicted"]),
      reason: z.string().describe("One short sentence citing the tool log."),
    }),
  ),
});

const AUDIT_SYSTEM = `You audit the record an AI agent left in a shared task graph against what it actually did.
You get the record's items (findings, decisions, the task status and brief, and lessons the agent had to follow) and the agent's tool log.
For each item answer:
- "supported": the tool log shows it (a command's output, a file written or read, a checkpoint).
- "contradicted": the tool log shows otherwise, or for a lesson, the agent did what the lesson forbids.
- "unsupported": the tool log neither shows nor contradicts it.
Judge only from the tool log. Do not reward confident wording.`;

const LOG_BUDGET = 40_000;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** The items of a task's record that the audit judges. */
function auditItems(project: Project, task: Concept): { id: string; kind: string; text: string }[] {
  const items: { id: string; kind: string; text: string }[] = [];
  for (const k of project.db.listConcepts({ parentId: task.id })) {
    if (k.dropped) continue;
    if (k.kind === "finding") items.push({ id: k.id, kind: "finding", text: k.body || k.title });
    else if (k.kind === "decision")
      items.push({ id: k.id, kind: "decision", text: k.body || k.title });
  }
  if (task.status)
    items.push({
      id: `${task.id}:status`,
      kind: "status",
      text: `The task ended "${task.status}".`,
    });
  if (task.brief) items.push({ id: `${task.id}:brief`, kind: "brief", text: task.brief });
  for (const l of project.lessonsInScope(task.id))
    items.push({
      id: l.id,
      kind: "lesson",
      text: `Lesson the agent had to follow: ${l.body || l.title}`,
    });
  return items;
}

/**
 * Audit one finished task (G2, docs/phase2-spec.md §15): a small model compares its findings,
 * decisions, status, brief and lessons in force with its tool log. The result is stored in
 * the project's gate directory and counted by `computeGate`.
 */
export async function auditTask(
  project: Project,
  taskId: string,
  o: { client: Anthropic; model: string; prices: Record<string, ModelPrice> },
): Promise<TaskAudit | null> {
  const task = project.getConcept(taskId);
  if (task?.kind !== "task") return null;
  const rec = (await taskRecords(project)).get(taskId);
  if (!rec?.agents.length) return null;
  const items = auditItems(project, task);
  if (!items.length) return null;
  // The tool log, newest kept when it is long.
  const lines = rec.tools.map(
    (t) =>
      `- ${t.name} ${clip(JSON.stringify(t.input), 400)}${t.result ? `\n  → ${clip(t.result, 300)}` : ""}`,
  );
  let log = "";
  for (let i = lines.length - 1; i >= 0 && log.length < LOG_BUDGET; i--)
    log = `${lines[i]}\n${log}`;
  const checkpoints = rec.nodes
    .filter((n) => n.kind === "semantic")
    .map(
      (n) =>
        `- ${n.status}: ${clip(n.summary ?? "", 200)} (+${n.linesAdded ?? 0} -${n.linesDeleted ?? 0} lines)`,
    );
  const content = [
    `Task: ${task.title}${task.body ? `\n${clip(task.body, 600)}` : ""}`,
    `Items to judge:\n${items.map((i) => `[${i.id}] (${i.kind}) ${clip(i.text, 600)}`).join("\n")}`,
    `Checkpoints:\n${checkpoints.join("\n") || "(none)"}`,
    `Tool log${lines.length > log.split("\n- ").length ? " (latest part)" : ""}:\n${log || "(empty)"}`,
  ].join("\n\n");
  const response = await o.client.messages.parse({
    model: o.model,
    max_tokens: 8000,
    system: AUDIT_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(AuditSchema), effort: "low" },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output)
    throw new Error(`the audit returned no verdicts (stop_reason ${response.stop_reason})`);
  const byId = new Map(response.parsed_output.items.map((i) => [i.id, i]));
  const judged = items.map((i) => {
    const v = byId.get(i.id);
    return {
      ...i,
      verdict: v?.verdict ?? ("unsupported" as const),
      reason: v?.reason ?? "no verdict returned",
    };
  });
  const u = response.usage;
  const costUsd = estimateCost(
    {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
    priceFor(o.prices, o.model),
  );
  const audit: TaskAudit = {
    taskId,
    at: new Date().toISOString(),
    version: task.version,
    model: o.model,
    items: judged,
    agreement: judged.filter((j) => j.verdict === "supported").length / judged.length,
    costUsd,
    runCostUsd: rec.costUsd,
  };
  await saveAudit(project, audit);
  return audit;
}

/** Audit finished tasks that have no audit for their current version (or all with `force`). */
export async function auditTasks(
  project: Project,
  o: {
    client: Anthropic;
    model: string;
    prices: Record<string, ModelPrice>;
    taskIds?: string[];
    force?: boolean;
    onAudit?: (a: TaskAudit) => void;
  },
): Promise<TaskAudit[]> {
  const audits = await readAudits(project);
  const finished = new Set(["done", "blocked", "failed", "need_decision", "abandoned"]);
  const ids =
    o.taskIds ??
    project.db
      .listConcepts({ kind: "task" })
      .filter((t) => !t.dropped && finished.has(t.status ?? "") && t.branches?.length)
      .filter((t) => o.force || audits[t.id]?.version !== t.version)
      .map((t) => t.id);
  const out: TaskAudit[] = [];
  for (const id of ids) {
    const a = await auditTask(project, id, o);
    if (a) {
      out.push(a);
      o.onAudit?.(a);
    }
  }
  return out;
}

const ExportCheckSchema = z.object({
  goal: z.object({ clear: z.boolean(), answer: z.string() }),
  results: z.object({ clear: z.boolean(), answer: z.string() }),
  decisions: z.object({ clear: z.boolean(), answer: z.string() }),
  openQuestions: z.object({ clear: z.boolean(), answer: z.string() }),
});

export type ExportCheck = z.infer<typeof ExportCheckSchema> & { costUsd: number };

/**
 * The optional model proxy for G3 (`turtle share --check`): from the export alone, can a
 * reader say what the goal was, what came out (with evidence), what was decided, and what
 * is still open?
 */
export async function checkExport(
  text: string,
  o: { client: Anthropic; model: string; prices: Record<string, ModelPrice> },
): Promise<ExportCheck> {
  const response = await o.client.messages.parse({
    model: o.model,
    max_tokens: 4000,
    system:
      "You read a project report someone shared with you, with no other context. Answer each question from the report alone, briefly. Mark a question not clear when the report does not let you answer it with confidence, or the results lack evidence.",
    messages: [
      {
        role: "user",
        content: `Report:\n\n${text.slice(0, 150_000)}\n\nQuestions: (1) What was the goal? (2) What are the results, and what evidence supports them? (3) What was decided? (4) What is still open?`,
      },
    ],
    output_config: { format: zodOutputFormat(ExportCheckSchema), effort: "low" },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output)
    throw new Error(`the export check returned nothing (stop_reason ${response.stop_reason})`);
  const u = response.usage;
  return {
    ...response.parsed_output,
    costUsd: estimateCost(
      {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      priceFor(o.prices, o.model),
    ),
  };
}

/** Plain text of an export's HTML, for the model check. */
export function exportText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/src="data:[^"]+"/g, "")
    .replace(/<(br|\/p|\/li|\/h\d|\/tr|\/section)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
