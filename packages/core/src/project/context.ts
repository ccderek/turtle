import type { Project } from "./project.js";
import { replayContext } from "./recipes.js";
import type { Concept } from "./types.js";
import { shortConceptIds } from "./view.js";

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function ancestors(p: Project, c: Concept): Concept[] {
  const out: Concept[] = [];
  let cur = c.parentId ? p.getConcept(c.parentId) : null;
  while (cur) {
    out.push(cur);
    cur = cur.parentId ? p.getConcept(cur.parentId) : null;
  }
  return out;
}

function lessonLines(p: Project, task: Concept, short: (id: string) => string): string[] {
  return p.lessonsInScope(task.id).map((l) => {
    const src = p.db.listLinks({ from: l.id, rel: "provenance" })[0];
    const from = src?.to.type === "concept" ? p.getConcept(src.to.id) : null;
    const origin = from
      ? ` (from ${from.status === "abandoned" ? "abandoned " : ""}"${from.title}")`
      : "";
    const state = l.lessonState === "proposed" ? " [proposed, not yet confirmed]" : "";
    return `- ${clip(l.body || l.title, 600).replace(/\n+/g, " ")}${origin}${state} [${short(l.id)}]`;
  });
}

function checkLines(p: Project, task: Concept): string[] {
  return p.checksInScope(task.id).map((c) => {
    const last = task.checkResults?.[c.id];
    const state = last ? (last.ok ? " [passed last time]" : " [FAILED last time]") : "";
    return `### ${c.title} (${c.file})${state}\n\`\`\`\n${clip(c.script ?? "", 1500)}\n\`\`\``;
  });
}

function dependencyLines(p: Project, task: Concept): string[] {
  const out: string[] = [];
  for (const id of task.dependsOn ?? []) {
    const d = p.getConcept(id);
    if (!d) continue;
    out.push(`- "${d.title}" [${d.status ?? "todo"}]`);
    for (const f of p.db.listConcepts({ parentId: d.id })) {
      if (f.kind === "finding") out.push(`  - found: ${clip(f.title, 200)}`);
      else if (f.kind === "output")
        out.push(
          `  - output: ${f.path ?? f.title}${f.sha256 ? ` (sha256 ${f.sha256.slice(0, 12)})` : ""}`,
        );
      else if (f.kind === "decision") out.push(`  - decided: ${clip(f.title, 200)}`);
    }
  }
  return out;
}

function decisionLines(p: Project, task: Concept): string[] {
  const out: string[] = [];
  for (const a of [task, ...ancestors(p, task)]) {
    for (const d of p.db.listConcepts({ parentId: a.id, kind: "decision" }))
      out.push(`- ${clip(d.title, 200)}`);
  }
  return out;
}

/**
 * The prompt for a task's new or forked run (docs/phase2-spec.md §7.2): compact, and
 * built only from the graph, so a forked run carries lessons instead of failed
 * transcripts.
 */
export function assembleTaskContext(p: Project, taskId: string, instruction?: string): string {
  const task = p.getConcept(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const short = shortConceptIds(p);
  const chain = ancestors(p, task);
  const goal = chain.find((c) => c.kind === "goal");
  const parts: string[] = [`# Your task: ${task.title}`];
  if (task.body) parts.push(task.body.trim());
  const replay = replayContext(p, task);
  if (replay) parts.push(replay);
  if (goal) parts.push(`## Goal\n${goal.title}${goal.body ? `\n${clip(goal.body, 800)}` : ""}`);
  const path = chain.filter((c) => c.kind === "task").reverse();
  if (path.length)
    parts.push(
      `## Where this fits\n${path.map((c) => `- ${c.title}`).join("\n")}\n- → ${task.title}`,
    );
  const lessons = lessonLines(p, task, short);
  if (lessons.length)
    parts.push(
      `## Lessons you must follow\nEarlier work under this part of the project learned these. Do not repeat those mistakes.\n${lessons.join("\n")}`,
    );
  const checks = checkLines(p, task);
  if (checks.length)
    parts.push(
      `## Checks that must pass\nturtle runs these scripts in your working directory at every checkpoint. The task cannot end done while one fails, and you cannot change them.\n\n${checks.join("\n\n")}`,
    );
  const decisions = decisionLines(p, task);
  if (decisions.length) parts.push(`## Decisions already made\n${decisions.join("\n")}`);
  const deps = dependencyLines(p, task);
  if (deps.length) parts.push(`## Results you can use\n${deps.join("\n")}`);
  if (instruction?.trim()) parts.push(`## Instruction\n${instruction.trim()}`);
  parts.push(
    `Your task id is ${short(task.id)}. Use mcp__turtle__graph to see the graph around it.`,
  );
  return parts.join("\n\n");
}

/** Compact text for the turtle_graph tool. */
export function graphText(p: Project, taskId: string, scope: "task" | "goal" = "task"): string {
  const task = p.getConcept(taskId);
  if (!task) return "(unknown task)";
  const short = shortConceptIds(p);
  const line = (c: Concept) => `${c.title} [${c.status ?? c.kind}] (${short(c.id)})`;
  const chain = ancestors(p, task);
  const goal = chain.find((c) => c.kind === "goal");
  const out: string[] = [];
  if (goal) out.push(`Goal: ${goal.title}`);
  out.push(`Your task: ${line(task)}`);
  const lessons = lessonLines(p, task, short);
  if (lessons.length) out.push("Lessons you must follow:", ...lessons);
  const decisions = decisionLines(p, task);
  if (decisions.length) out.push("Decisions:", ...decisions);
  const deps = dependencyLines(p, task);
  if (deps.length) out.push("Depends on:", ...deps);
  const kids = p.db.listConcepts({ parentId: task.id });
  const subtasks = kids.filter((k) => k.kind === "task");
  if (subtasks.length) out.push("Your subtasks:", ...subtasks.map((k) => `- ${line(k)}`));
  const findings = kids.filter((k) => k.kind === "finding");
  if (findings.length)
    out.push("Your findings:", ...findings.map((k) => `- ${clip(k.title, 160)}`));
  const open = kids.filter((k) => k.kind === "question" && !k.answer);
  if (open.length) out.push("Open questions:", ...open.map((k) => `- ${k.title}`));
  if (task.parentId) {
    const sib = p.db
      .listConcepts({ parentId: task.parentId })
      .filter((c) => c.kind === "task" && c.id !== task.id);
    if (sib.length) out.push("Sibling tasks:", ...sib.map((c) => `- ${line(c)}`));
  }
  if (scope === "goal" && goal) {
    const all = p.db
      .listConcepts({ kind: "task" })
      .filter((t) => ancestors(p, t).some((a) => a.id === goal.id));
    out.push("All tasks under the goal:", ...all.map((t) => `- ${line(t)}`));
  }
  return out.join("\n");
}
