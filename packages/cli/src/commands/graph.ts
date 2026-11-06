import {
  type Concept,
  type GraphTreeNode,
  graphTree,
  importAllSources,
  OpsError,
  type Project,
  shortConceptIds,
} from "@turtle/core";
import { CliError } from "../context.js";
import { c, firstLine, truncate } from "../render.js";
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

const STATUS_MARK: Record<string, (s: string) => string> = {
  todo: (s) => c.dim(s),
  running: c.blue,
  need_decision: c.yellow,
  blocked: c.yellow,
  done: c.green,
  paused: (s) => c.dim(s),
  failed: c.red,
  dropped: (s) => c.dim(s),
};
const STATUS_ICON: Record<string, string> = {
  todo: "○",
  running: "●",
  need_decision: "?",
  blocked: "!",
  done: "✓",
  paused: "‖",
  failed: "✗",
  dropped: "⌀",
};
const KIND_LABEL: Record<string, string> = {
  finding: "finding",
  decision: "decision",
  question: "question",
  output: "output",
};

export function conceptLine(n: Concept, short: (id: string) => string): string {
  const id = c.dim(short(n.id).padEnd(6));
  if (n.kind === "goal") return `${id} ${c.bold(n.title)}`;
  if (n.kind === "task") {
    const st = n.status ?? "todo";
    const paint = STATUS_MARK[st] ?? ((s: string) => s);
    const deps = n.dependsOn?.length ? c.dim(`  after ${n.dependsOn.map(short).join(", ")}`) : "";
    const from = n.startFrom ? c.dim(`  from ${short(n.startFrom.taskId)}`) : "";
    return `${id} ${paint(`${STATUS_ICON[st] ?? "·"} ${n.title}`)}  ${paint(c.dim(st))}${deps}${from}${n.dropped ? c.dim(" (dropped)") : ""}`;
  }
  const label = KIND_LABEL[n.kind] ?? n.kind;
  const answered =
    n.kind === "question" && n.answer ? c.dim(`  → ${truncate(n.answer.text, 50)}`) : "";
  return `${id} ${c.cyan(label)} ${truncate(n.title, 90)}${answered}`;
}

function render(nodes: GraphTreeNode[], short: (id: string) => string, prefix = ""): string[] {
  const out: string[] = [];
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const branch = prefix === "" && n.concept.kind === "goal" ? "" : last ? "└─ " : "├─ ";
    out.push(`${c.dim(prefix + branch)}${conceptLine(n.concept, short)}`);
    const next = prefix === "" && n.concept.kind === "goal" ? "" : prefix + (last ? "   " : "│  ");
    out.push(...render(n.children, short, next));
  });
  return out;
}

export async function graphCommand(
  cwd: string,
  o: { goal?: string; all?: boolean },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const short = shortConceptIds(p);
    const goalId = o.goal ? p.resolveConcept(o.goal).id : undefined;
    const trees = graphTree(p, { ...(goalId ? { goalId } : {}), includeDropped: o.all ?? false });
    if (!trees.length) return [c.dim('no goals yet: turtle goal "<what you want>"')];
    return trees.flatMap((t, i) => [...(i ? [""] : []), ...render([t], short)]);
  });
}

export async function goalCommand(
  cwd: string,
  text: string,
  o: { body?: string },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const g = await p.createConcept({
      kind: "goal",
      parentId: null,
      title: firstLine(text),
      body: o.body ?? text.split("\n").slice(1).join("\n").trim(),
    });
    return [`goal ${c.bold(shortConceptIds(p)(g.id))} ${g.title}`];
  });
}

export async function taskAddCommand(
  cwd: string,
  title: string,
  o: { parent?: string; after?: string[]; from?: string; body?: string; noAgent?: boolean },
): Promise<string[]> {
  return withProject(cwd, async (p) => {
    let parentId: string;
    if (o.parent) parentId = p.resolveConcept(o.parent).id;
    else {
      const goals = p.db.listConcepts({ kind: "goal" });
      const latest = goals.at(-1);
      if (!latest) throw new CliError('no goal yet: turtle goal "<what you want>"');
      parentId = latest.id;
    }
    const startFromTask = o.from ? p.resolveConcept(o.from) : null;
    const t = await p.createConcept({
      kind: "task",
      parentId,
      title,
      ...(o.body ? { body: o.body } : {}),
      dependsOn: (o.after ?? []).map((a) => p.resolveConcept(a).id),
      assignee: o.noAgent ? { type: "member", id: p.identity.memberId } : { type: "agent" },
      ...(startFromTask ? { startFrom: { taskId: startFromTask.id, checkpointId: "latest" } } : {}),
    });
    return [`task ${c.bold(shortConceptIds(p)(t.id))} ${t.title}  ${c.dim(t.status ?? "")}`];
  });
}

export async function taskShowCommand(cwd: string, ref: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const short = shortConceptIds(p);
    const n = p.resolveConcept(ref);
    const out = [
      conceptLine(n, short),
      c.dim(`${n.id}  v${n.version}  by ${n.createdBy.id}  ${n.createdAt}`),
    ];
    if (n.body) out.push("", ...n.body.split("\n").map((l) => `  ${l}`));
    if (n.brief) out.push("", c.bold("brief"), ...n.brief.split("\n").map((l) => `  ${l}`));
    if (n.branches?.length)
      out.push("", `code   ${n.branches.map((b) => `${b.source}:${b.branch}`).join(", ")}`);
    const links = p.db.listLinks({ from: n.id });
    if (links.length)
      out.push("", c.bold("links"), ...links.map((l) => `  ${l.rel} → ${l.to.type} ${l.to.id}`));
    const ops = p.db.listOps({ concept: n.id });
    out.push("", c.bold("history"));
    for (const op of ops)
      out.push(c.dim(`  ${op.id.slice(0, 10)}  ${op.at}  ${op.actor.id}  ${op.change.kind}`));
    return out;
  });
}

export async function taskDropCommand(cwd: string, ref: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const n = p.resolveConcept(ref);
    await p.dropConcept(n.id);
    return [
      `dropped ${n.title}  ${c.dim("(undo: turtle undo with its operation id, see turtle task show)")}`,
    ];
  });
}

export async function answerCommand(cwd: string, ref: string, text: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const d = await p.answerQuestion(p.resolveConcept(ref).id, text);
    return [`answered; decision ${shortConceptIds(p)(d.id)} recorded`];
  });
}

export async function undoCommand(cwd: string, opRef: string): Promise<string[]> {
  return withProject(cwd, async (p) => {
    const op = p.db.listOps().find((o) => o.id.startsWith(opRef));
    if (!op) throw new CliError(`unknown operation: ${opRef}`);
    const inverse = await p.undo(op.id);
    return [
      `undid ${op.change.kind} (${inverse.length} inverse operation${inverse.length === 1 ? "" : "s"})`,
    ];
  });
}
