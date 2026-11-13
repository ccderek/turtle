import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  anthropicClient,
  auditTasks,
  buildExport,
  checkExport,
  computeGate,
  exportText,
  type GateReport,
  hasApiCredentials,
  importAllSources,
  loadConfig,
  OpsError,
  type Project,
  recordJudgment,
  type TurtleConfig,
} from "@turtle/core";
import { CliError } from "../context.js";
import { c } from "../render.js";
import { requireProject } from "./project.js";

async function withProject<T>(cwd: string, fn: (p: Project) => Promise<T>): Promise<T> {
  const p = await requireProject(cwd);
  try {
    await importAllSources(p);
    return await fn(p);
  } catch (err) {
    if (err instanceof OpsError) throw new CliError(err.message);
    throw err;
  } finally {
    p.close();
  }
}

async function configOf(p: Project, cwd: string): Promise<TurtleConfig> {
  return loadConfig(p.config.sources[0]?.path ?? cwd);
}

const hasCredentials = () => hasApiCredentials();

/**
 * `turtle share <task|goal>`: one self-contained HTML file (docs/phase2-spec.md §10).
 * `--check` scans it for leftovers and, with an API key, asks a model the four G3
 * questions from the file alone. `--judge yyyn` records your own answers (goal, results,
 * decisions, open questions) for the gate.
 */
export async function shareCommand(
  cwd: string,
  ref: string,
  o: { output?: string; check?: boolean; judge?: string; notes?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const target = p.resolveConcept(ref);
    const e = await buildExport(p, target.id);
    const out = resolve(cwd, o.output ?? e.fileName);
    await writeFile(out, e.html);
    const counts = Object.entries(e.counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    const red = Object.entries(e.redactions)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    const lines = [
      `wrote ${c.bold(out)} (${Math.round(e.bytes / 1024)} KB)`,
      `  ${counts}; ${e.inlined} output(s) inlined, ${e.listed} listed by path`,
      `  redacted: ${red || "nothing"}`,
      e.leaks.length
        ? c.red(`  still looks sensitive: ${e.leaks.join("; ")}`)
        : `  ${c.green("✓")} no secrets or home paths left`,
    ];
    if (o.check) {
      if (!hasCredentials()) lines.push(c.dim("  model check skipped: set ANTHROPIC_API_KEY"));
      else {
        const config = await configOf(p, cwd);
        const r = await checkExport(exportText(e.html), {
          client: anthropicClient(),
          model: config.checkpoint.summarizerModel,
          prices: config.prices,
        });
        lines.push(`  model check ($${r.costUsd.toFixed(4)}):`);
        for (const [k, v] of Object.entries({
          goal: r.goal,
          results: r.results,
          decisions: r.decisions,
          "open questions": r.openQuestions,
        }))
          lines.push(`    ${v.clear ? c.green("✓") : c.red("✗")} ${k}: ${v.answer}`);
      }
    }
    if (o.judge) {
      const a = o.judge.toLowerCase();
      if (!/^[yn]{4}$/.test(a))
        throw new CliError("--judge takes 4 letters y/n: goal, results, decisions, open questions");
      await recordJudgment(p, {
        conceptId: target.id,
        title: target.title,
        at: new Date().toISOString(),
        by: p.identity.memberId,
        clear: {
          goal: a[0] === "y",
          results: a[1] === "y",
          decisions: a[2] === "y",
          openQuestions: a[3] === "y",
        },
        redactions: Object.values(e.redactions).reduce((s, v) => s + v, 0),
        leaks: e.leaks,
        ...(o.notes ? { notes: o.notes } : {}),
      });
      lines.push(`  judgment recorded for the gate (G3)`);
    }
    return lines;
  });
}

/** `turtle audit`: the G2 audit of finished tasks with a small model. */
export async function auditCommand(
  cwd: string,
  o: { task?: string[]; force?: boolean; model?: string },
): Promise<string[]> {
  if (!hasCredentials())
    throw new CliError("the audit calls a model: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)");
  return withProject(cwd, async (p) => {
    const config = await configOf(p, cwd);
    const model = o.model ?? config.checkpoint.summarizerModel;
    const lines: string[] = [];
    const audits = await auditTasks(p, {
      client: anthropicClient(),
      model,
      prices: config.prices,
      ...(o.task?.length ? { taskIds: o.task.map((t) => p.resolveConcept(t).id) } : {}),
      ...(o.force ? { force: true } : {}),
      onAudit: (a) => {
        const t = p.getConcept(a.taskId);
        lines.push(
          `${a.agreement >= 0.85 ? c.green("✓") : c.red("✗")} ${t?.title ?? a.taskId}: ${(a.agreement * 100).toFixed(0)}% supported ($${a.costUsd.toFixed(4)})`,
        );
        for (const i of a.items.filter((x) => x.verdict !== "supported"))
          lines.push(`    ${i.verdict}: (${i.kind}) ${i.text.slice(0, 90)} — ${i.reason}`);
      },
    });
    if (!audits.length)
      lines.push("nothing to audit: every finished task has an audit for its current version");
    return lines;
  });
}

/** `turtle stats --gate`: G1–G5 with pass/fail against docs/phase2-spec.md §1. */
export async function gateCommand(
  cwd: string,
  o: { json?: boolean },
): Promise<{ lines: string[]; ok: boolean }> {
  return withProject(cwd, async (p) => {
    const g = await computeGate(p);
    if (o.json) return { lines: [JSON.stringify(g, null, 2)], ok: g.pass !== false };
    return { lines: renderGate(g), ok: g.pass !== false };
  });
}

export function renderGate(g: GateReport): string[] {
  const mark = (v: boolean | null) =>
    v === true ? c.green("pass") : v === false ? c.red("FAIL") : c.dim("—");
  const lines = [`Phase 2 gate for ${c.bold(g.project)}: ${mark(g.pass)}`];
  for (const grp of g.groups) {
    lines.push(
      "",
      `${c.bold(grp.id === "latency" ? "Redirect" : grp.id)} ${grp.title} — ${grp.question}  ${mark(grp.pass)}`,
    );
    for (const m of grp.metrics)
      lines.push(
        `  ${m.pass === true ? c.green("✓") : m.pass === false ? c.red("✗") : " "} ${m.label}: ${c.bold(m.display)}${m.target ? c.dim(` (target ${m.target})`) : ""}${m.detail ? c.dim(` · ${m.detail}`) : ""}`,
      );
  }
  return lines;
}
