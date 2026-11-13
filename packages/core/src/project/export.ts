import { homedir } from "node:os";
import { join } from "node:path";
import { TurtleDb } from "../db/db.js";
import { GitStore } from "../git/store.js";
import { OpsError } from "../ops.js";
import { readOutput } from "./outputs.js";
import type { Project } from "./project.js";
import type { Concept } from "./types.js";
import { shortConceptIds } from "./view.js";

/** What an export holds, shown before it is written (docs/phase2-spec.md §10). */
export interface ExportSummary {
  title: string;
  fileName: string;
  counts: Record<string, number>;
  /** Outputs whose content is in the file (text and small images). */
  inlined: number;
  /** Outputs listed by path and sha256 only (too large, binary or unreadable). */
  listed: number;
  redactions: Record<string, number>;
  /** Anything that still looks like a secret or a home path after redaction (should be empty). */
  leaks: string[];
  bytes: number;
}

export interface ShareExport extends ExportSummary {
  html: string;
}

const MAX_INLINE = 1024 * 1024;

// ------------------------------------------------------------------ redaction

interface Redactor {
  re: RegExp;
  kind: string;
  to: string;
}

function redactors(): Redactor[] {
  const home = homedir();
  const list: Redactor[] = [];
  if (home && home.length > 1)
    list.push({ re: new RegExp(escapeRe(home), "g"), kind: "home path", to: "~" });
  list.push(
    { re: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/|\b)/g, kind: "home path", to: "~" },
    {
      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      kind: "private key",
      to: "[redacted private key]",
    },
    { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, kind: "token", to: "[redacted]" },
    { re: /\bsk-[A-Za-z0-9]{32,}/g, kind: "token", to: "[redacted]" },
    { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, kind: "token", to: "[redacted]" },
    { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, kind: "token", to: "[redacted]" },
    { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, kind: "token", to: "[redacted]" },
    { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: "token", to: "[redacted]" },
    { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g, kind: "token", to: "$1 [redacted]" },
    {
      re: /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?))\s*([=:])\s*(["']?)[^\s"']{4,}\3/g,
      kind: "env secret",
      to: "$1$2[redacted]",
    },
  );
  return list;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace home paths and things that look like secrets; counts what was replaced. */
export function redact(text: string, counts: Record<string, number> = {}): string {
  let out = text;
  for (const r of redactors()) {
    out = out.replace(r.re, (...m: string[]) => {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      return r.to.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? "");
    });
  }
  return out;
}

/** What still looks like a secret or a home path in a text (the export check). */
export function scanForLeaks(text: string): string[] {
  const found: string[] = [];
  for (const r of redactors()) {
    for (const m of text.matchAll(r.re)) {
      const s = m[0];
      if (s.includes("[redacted")) continue;
      found.push(`${r.kind}: ${s.length > 24 ? `${s.slice(0, 12)}…` : s}`);
    }
  }
  return [...new Set(found)];
}

// ------------------------------------------------------------------ export

const STATUS: Record<string, string> = {
  todo: "to do",
  running: "running",
  paused: "paused",
  need_decision: "needs a decision",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  abandoned: "abandoned (kept)",
  dropped: "dropped",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "export"
  );
}

/** Checkpoint summaries, looked up in the task's sources (opened once, closed at the end). */
class Checkpoints {
  private readonly dbs = new Map<string, TurtleDb | null>();
  constructor(private readonly project: Project) {}
  async summary(task: Concept, nodeId: string): Promise<string | null> {
    for (const b of task.branches ?? []) {
      let db = this.dbs.get(b.source);
      if (db === undefined) {
        const src = this.project.config.sources.find((s) => s.id === b.source);
        db = src
          ? TurtleDb.open(join((await GitStore.open(src.path)).turtleDir, "turtle.db"))
          : null;
        this.dbs.set(b.source, db);
      }
      const n = db?.getNode(nodeId);
      if (n) return n.summary;
    }
    return null;
  }
  close() {
    for (const db of this.dbs.values()) db?.close();
  }
}

/**
 * One self-contained HTML file for a task or goal and everything under it (docs/phase2-spec.md
 * §10): briefs, findings with their evidence (small text and image outputs inlined), decisions,
 * questions and answers, lessons, checks and recipes. Never transcripts or environment
 * variables; home paths and anything that looks like a secret are redacted.
 */
export async function buildExport(
  project: Project,
  rootId: string,
  o: { now?: Date; maxInline?: number } = {},
): Promise<ShareExport> {
  const root = project.getConcept(rootId);
  if (!root || (root.kind !== "task" && root.kind !== "goal"))
    throw new OpsError("export a task or a goal");
  const now = o.now ?? new Date();
  const maxInline = o.maxInline ?? MAX_INLINE;
  const short = shortConceptIds(project);
  const counts: Record<string, number> = {};
  const redactions: Record<string, number> = {};
  const r = (s: string) => esc(redact(s, redactions));
  let inlined = 0;
  let listed = 0;
  const cps = new Checkpoints(project);
  const kids = (id: string) =>
    project.db
      .listConcepts({ parentId: id })
      .filter((c) => !c.dropped)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const count = (k: string) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const evidenceOf = (id: string) =>
    project.db.listLinks({ from: id, rel: "evidence" }).filter((l) => !l.removed);

  const outputHtml = async (out: Concept): Promise<string> => {
    const head = `<div class="out-head"><code>${r(out.path ?? out.title)}</code> <span class="muted">${out.size !== undefined ? `${out.size.toLocaleString("en")} bytes · ` : ""}sha256 ${esc((out.sha256 ?? "").slice(0, 16))}</span></div>`;
    try {
      if ((out.size ?? 0) > maxInline) throw new Error("large");
      const c = await readOutput(project, out.id);
      if (c.binary) {
        const ext = (c.path.split(".").pop() ?? "").toLowerCase();
        const mime = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        }[ext];
        if (mime && c.size <= maxInline) {
          const data = await readBinary(project, out.id);
          if (data) {
            inlined++;
            return `${head}<img alt="${r(c.path)}" src="data:${mime};base64,${data.toString("base64")}">`;
          }
        }
        throw new Error("binary");
      }
      const text = c.text ?? "";
      inlined++;
      const note = c.matches
        ? ""
        : `<p class="warn">The file changed after the agent cited it; this is the latest version.</p>`;
      if (/\.(csv|tsv)$/i.test(c.path))
        return `${head}${note}${csvTable(redact(text, redactions), c.path.endsWith(".tsv") ? "\t" : ",")}`;
      return `${head}${note}<pre>${r(text)}</pre>${c.truncated ? `<p class="muted">First 256 KB.</p>` : ""}`;
    } catch {
      listed++;
      return head;
    }
  };

  const evidenceHtml = async (task: Concept, id: string): Promise<string> => {
    const items: string[] = [];
    for (const l of evidenceOf(id)) {
      if (l.to.type === "concept") {
        const out = project.getConcept(l.to.id);
        if (out?.kind === "output")
          items.push(`<div class="evidence">${await outputHtml(out)}</div>`);
      } else if (l.to.type === "node") {
        const s = await cps.summary(task, l.to.id);
        items.push(
          `<div class="evidence">checkpoint <code>${esc(l.to.id.slice(0, 8))}</code>${s ? `: ${r(s.split("\n")[0] ?? "")}` : ""}</div>`,
        );
      }
    }
    return items.join("");
  };

  const section = async (c: Concept, depth: number, taskCtx: Concept | null): Promise<string> => {
    const task = c.kind === "task" ? c : taskCtx;
    const h = `h${Math.min(depth + 1, 6)}`;
    const children = kids(c.id);
    const parts: string[] = [];
    if (c.kind === "goal" || c.kind === "task") {
      count(c.kind === "goal" ? "goals" : "tasks");
      const st = c.kind === "task" ? (STATUS[c.status ?? "todo"] ?? c.status ?? "") : "";
      parts.push(
        `<${h}>${r(c.title)}${st ? ` <span class="badge s-${esc(c.status ?? "todo")}">${esc(st)}</span>` : ""}${c.replay ? ` <span class="badge">replay</span>` : ""}</${h}>`,
      );
      if (c.body) parts.push(`<p class="body">${r(c.body)}</p>`);
      if (c.brief) parts.push(`<div class="brief"><b>Brief.</b> ${r(c.brief)}</div>`);
      const facts: string[] = [];
      const deps = (c.dependsOn ?? [])
        .map((d) => project.getConcept(d))
        .filter(Boolean) as Concept[];
      if (deps.length) facts.push(`After: ${deps.map((d) => r(d.title)).join(", ")}`);
      if (c.startFrom) {
        const from = project.getConcept(c.startFrom.taskId);
        facts.push(
          `Started from checkpoint <code>${esc(c.startFrom.checkpointId.slice(0, 8))}</code> of “${r(from?.title ?? "a task")}”`,
        );
      }
      if (c.kind === "task") {
        const lastCp = evidenceOf(c.id)
          .filter((l) => l.to.type === "node")
          .at(-1);
        if (lastCp) {
          const s = await cps.summary(c, lastCp.to.id);
          facts.push(
            `Last checkpoint <code>${esc(lastCp.to.id.slice(0, 8))}</code>${s ? `: ${r(s.split("\n")[0] ?? "")}` : ""}`,
          );
        }
        const results = Object.entries(c.checkResults ?? {});
        if (results.length) {
          const failed = results.filter(([, x]) => !x.ok).length;
          facts.push(`Checks: ${results.length - failed} of ${results.length} pass`);
        }
      }
      if (facts.length)
        parts.push(`<ul class="facts">${facts.map((f) => `<li>${f}</li>`).join("")}</ul>`);
    }

    const lines: string[] = [];
    const subs: string[] = [];
    for (const k of children) {
      switch (k.kind) {
        case "finding": {
          count("findings");
          const ev = await evidenceHtml(task ?? c, k.id);
          lines.push(
            `<li class="finding"><span class="kind">finding</span> ${r(k.body || k.title)}${ev ? ev : ` <span class="muted">(claimed: no evidence attached)</span>`}</li>`,
          );
          break;
        }
        case "decision":
          count("decisions");
          lines.push(
            `<li><span class="kind">decision</span> ${r(k.title)}${k.body && k.body !== k.title ? `<div class="muted">${r(k.body)}</div>` : ""}</li>`,
          );
          break;
        case "question":
          count("questions");
          lines.push(
            `<li><span class="kind">question</span> ${r(k.title)}${k.answer ? ` → <b>${r(k.answer.text)}</b>` : ` <span class="badge s-need_decision">open</span>`}</li>`,
          );
          break;
        case "lesson":
          count("lessons");
          lines.push(
            `<li class="lesson"><span class="kind">lesson</span> ${r(k.body || k.title)} <span class="muted">(${esc(k.lessonState ?? "")})</span></li>`,
          );
          break;
        case "check": {
          if (k.checkState === "retired") break;
          count("checks");
          const res = task?.checkResults?.[k.id];
          lines.push(
            `<li><span class="kind">check</span> ${r(k.title)} <code>${esc(k.file ?? "")}</code>${k.checkState === "proposed" ? ` <span class="muted">(proposed)</span>` : ""}${res ? ` — ${res.ok ? "✓ passes" : `✗ fails: ${r(res.output.split("\n").slice(-2).join(" / "))}`}` : ""}</li>`,
          );
          break;
        }
        case "recipe": {
          count("recipes");
          const v = k.verification;
          const params = Object.entries(k.params ?? {})
            .map(([a, b]) => `${a}=${b}`)
            .join(" ");
          lines.push(
            `<li><span class="kind">recipe</span> ${r(k.title)} <code>${esc(k.file ?? "")}</code>${params ? ` <code>${r(params)}</code>` : ""} — ${esc(k.recipeState ?? "draft")}${v && !v.ok ? `: ${r(v.problems.join("; "))}` : ""}</li>`,
          );
          break;
        }
        case "output": {
          // Outputs cited as evidence appear with their finding; others are listed here.
          const cited = project.db
            .listLinks({ to: { type: "concept", id: k.id } })
            .some((l) => l.rel === "evidence" && !l.removed);
          if (cited) break;
          count("outputs");
          lines.push(`<li><span class="kind">output</span>${await outputHtml(k)}</li>`);
          break;
        }
        case "task":
          subs.push(await section(k, depth + 1, k));
          break;
      }
    }
    if (lines.length) parts.push(`<ul class="items">${lines.join("")}</ul>`);
    parts.push(...subs);
    return `<section class="${c.kind}">${parts.join("\n")}</section>`;
  };

  let body: string;
  try {
    body = await section(root, 0, root.kind === "task" ? root : null);
  } finally {
    cps.close();
  }
  const title = redact(root.title, redactions);
  const meta = `Exported from turtle · project ${esc(redact(project.config.name, redactions))} · ${esc(now.toISOString().slice(0, 16).replace("T", " "))} UTC · ${root.kind} ${esc(short(root.id))}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header><p class="muted">${meta}</p></header>
<main>
${body}
</main>
<footer><p class="muted">This file has the task graph's record: briefs, findings with evidence, decisions, lessons, checks and recipes. Agent transcripts and environment variables are not included; home paths and values that look like secrets were redacted.</p></footer>
</body>
</html>
`;
  const leaks = scanForLeaks(html.replace(/src="data:[^"]+"/g, ""));
  return {
    html,
    title,
    fileName: `${slug(root.title)}-${now.toISOString().slice(0, 10)}.html`,
    counts,
    inlined,
    listed,
    redactions,
    leaks,
    bytes: Buffer.byteLength(html),
  };
}

async function readBinary(project: Project, outputId: string): Promise<Buffer | null> {
  const out = project.getConcept(outputId);
  const task = out?.parentId ? project.getConcept(out.parentId) : null;
  if (!out?.path || !task?.branches?.length) return null;
  for (const b of task.branches) {
    const src = project.config.sources.find((s) => s.id === b.source);
    if (!src) continue;
    const store = await GitStore.open(src.path);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    try {
      const branch = db.getBranch(b.branch);
      let node = branch?.headNodeId ? db.getNode(branch.headNodeId) : null;
      for (let i = 0; node && i < 500; i++) {
        const data = await store.readBlob(`${node.commitSha}:${out.path}`).catch(() => null);
        if (data) return data;
        node = node.parents[0] ? db.getNode(node.parents[0]) : null;
      }
    } finally {
      db.close();
    }
  }
  return null;
}

function csvTable(text: string, sep: string): string {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(0, 501)
    .map((l) => l.split(sep));
  const [head, ...rest] = rows;
  if (!head) return "";
  return `<div class="table"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rest
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const CSS = `
:root { --bg:#fff; --fg:#1d1d1b; --muted:#6d6c66; --line:#e2e1dc; --soft:#f4f4f1; --ok:#2f8f5b; --ask:#b7791f; --bad:#c8312b; --run:#2f6fde; --lesson:#7c5cd6; }
@media (prefers-color-scheme: dark) { :root { --bg:#151614; --fg:#e9e8e3; --muted:#9d9c95; --line:#33342f; --soft:#1f201d; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 880px; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 26px; margin: 8px 0 6px; } h2 { font-size: 20px; margin: 28px 0 6px; } h3, h4, h5, h6 { font-size: 16px; margin: 20px 0 4px; }
section.task section.task { margin-left: 14px; padding-left: 14px; border-left: 2px solid var(--line); }
.muted { color: var(--muted); font-size: 13px; }
.badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); vertical-align: middle; }
.s-done { color: var(--ok); } .s-blocked, .s-failed { color: var(--bad); } .s-need_decision { color: var(--ask); } .s-running { color: var(--run); }
.brief { background: var(--soft); border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
.body { white-space: pre-wrap; }
ul.facts { margin: 6px 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
ul.items { list-style: none; padding: 0; margin: 8px 0; }
ul.items > li { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; margin: 6px 0; overflow-wrap: anywhere; }
.kind { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-right: 4px; }
li.lesson { border-color: var(--lesson); }
.evidence { margin-top: 6px; padding: 6px 8px; background: var(--soft); border-radius: 6px; font-size: 13px; }
.out-head { margin-bottom: 4px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, Menlo, monospace; margin: 4px 0; max-height: 420px; overflow: auto; }
code { font: 12px ui-monospace, Menlo, monospace; }
img { max-width: 100%; border-radius: 6px; }
.table { overflow: auto; max-height: 420px; } table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: 2px 8px; text-align: right; } th { background: var(--soft); text-align: left; }
.warn { color: var(--ask); font-size: 13px; }
footer { margin-top: 32px; border-top: 1px solid var(--line); padding-top: 8px; }
@media print { body { max-width: none; } pre, .table { max-height: none; } }
`;
