import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { git } from "../git/exec.js";
import { GitStore } from "../git/store.js";
import { newId } from "../ids.js";
import { OpsError } from "../ops.js";
import { turtleHome } from "../run/session.js";
import { GraphDb } from "./graph-db.js";
import { OpLog, rebuild } from "./oplog.js";
import {
  type Actor,
  type Change,
  CONCEPT_KINDS,
  type Concept,
  type ConceptField,
  type ConceptFields,
  type ConceptKind,
  type LinkRel,
  type LinkTarget,
  type Operation,
} from "./types.js";

export const PROJECT_FILE = "turtle-project.json";
/** File inside a code repository's `.git/turtle/` naming the project it belongs to. */
export const PROJECT_POINTER = "project";

export interface SourceConfig {
  id: string;
  kind: "git";
  path: string;
  url?: string;
}

export interface ResourceConfig {
  id: string;
  name: string;
  kind: "device" | "service" | "other";
}

export interface ProjectConfig {
  name: string;
  sources: SourceConfig[];
  resources: ResourceConfig[];
  defaults: {
    sandbox?: "none" | "docker";
    model?: string;
    maxParallel?: number;
    maxBudgetUsd?: number;
    planOnGoal?: boolean;
    /** Start ready agent tasks on their own while `turtle ui` runs (default true). */
    autoStart?: boolean;
  };
}

export interface MemberIdentity {
  memberId: string;
  name: string;
  replicaId: string;
}

/** `~/.turtle/identity.json`, created on first use (docs/phase2-spec.md §4.2). */
export async function loadIdentity(
  home = turtleHome(),
  nameHint?: string,
): Promise<MemberIdentity> {
  const path = join(home, "identity.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as MemberIdentity;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let name = nameHint ?? "";
  if (!name) {
    try {
      name = await git(["config", "--get", "user.name"]);
    } catch {
      name = "";
    }
  }
  const id: MemberIdentity = { memberId: `m_${newId()}`, name: name || "me", replicaId: newId() };
  await mkdir(home, { recursive: true });
  await writeFile(path, `${JSON.stringify(id, null, 2)}\n`);
  return id;
}

const SET_FIELDS: readonly ConceptField[] = [
  "parentId",
  "title",
  "body",
  "status",
  "assignee",
  "dependsOn",
  "sources",
  "resources",
  "startFrom",
  "branches",
  "role",
  "brief",
  "options",
  "answer",
  "path",
  "sha256",
  "size",
  "lessonState",
  "order",
  "file",
  "script",
  "checkState",
  "checkResults",
];

/** Check scripts: a plain file name whose extension picks the interpreter (D31). */
export const CHECK_FILE = /^[\w.-]{1,80}\.(py|sh|js|mjs)$/;
const MAX_CHECK_SCRIPT = 64 * 1024;

/** Thrown when an agent edits a field a member changed after the agent last read it. */
export class StaleEditError extends OpsError {
  constructor(
    readonly conceptId: string,
    readonly fields: string[],
    by: string,
  ) {
    super(
      `${by} changed ${fields.join(", ")} of ${conceptId} since you read it; re-read and retry`,
    );
    this.name = "StaleEditError";
  }
}

/**
 * A turtle project (docs/phase2-spec.md §4): its own git repository holding the task
 * graph's operation log, with code repositories attached as sources.
 */
export class Project {
  private constructor(
    readonly dir: string,
    public config: ProjectConfig,
    readonly store: GitStore,
    readonly db: GraphDb,
    readonly log: OpLog,
    readonly identity: MemberIdentity,
  ) {}

  get me(): Actor {
    return { type: "member", id: this.identity.memberId };
  }

  get turtleDir(): string {
    return this.store.turtleDir;
  }

  // ----------------------------------------------------------- lifecycle

  static async create(
    dir: string,
    o: { name?: string; sources?: string[]; home?: string } = {},
  ): Promise<Project> {
    const root = resolve(dir);
    if (existsSync(join(root, PROJECT_FILE)))
      throw new OpsError(`a project already exists in ${root}`);
    await mkdir(root, { recursive: true });
    if (!existsSync(join(root, ".git"))) await git(["init", "-q", "-b", "main"], { cwd: root });
    const config: ProjectConfig = {
      name: o.name ?? basename(root),
      sources: [],
      resources: [],
      defaults: {},
    };
    for (const s of o.sources ?? []) config.sources.push(await sourceFor(s, config.sources));
    const identity = await loadIdentity(o.home);
    await writeConfig(root, config, identity, "Create turtle project");
    for (const s of config.sources) await writePointer(s.path, root);
    return Project.open(root, { home: o.home });
  }

  static async open(dir: string, o: { home?: string } = {}): Promise<Project> {
    const root = resolve(dir);
    let config: ProjectConfig;
    try {
      config = JSON.parse(await readFile(join(root, PROJECT_FILE), "utf8")) as ProjectConfig;
    } catch {
      throw new OpsError(`not a turtle project: ${root} (no ${PROJECT_FILE})`);
    }
    config.sources ??= [];
    config.resources ??= [];
    config.defaults ??= {};
    const store = await GitStore.open(root);
    const identity = await loadIdentity(o.home);
    const db = GraphDb.open(join(store.turtleDir, "project.db"));
    const log = new OpLog({
      store,
      db,
      replica: `${identity.memberId}/${identity.replicaId}`,
      lockFile: join(store.turtleDir, "ops.lock"),
      committer: { name: identity.name, email: `${identity.memberId}@turtle.invalid` },
    });
    const p = new Project(root, config, store, db, log, identity);
    await log.repair();
    return p;
  }

  /**
   * The project for a directory: a project directory (or inside one), or a code
   * repository whose `.git/turtle/project` points at its project.
   */
  static async find(cwd: string, o: { home?: string } = {}): Promise<Project | null> {
    let cur = resolve(cwd);
    for (;;) {
      if (existsSync(join(cur, PROJECT_FILE))) return Project.open(cur, o);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    try {
      const store = await GitStore.open(cwd);
      const pointer = join(store.turtleDir, PROJECT_POINTER);
      if (existsSync(pointer)) return Project.open((await readFile(pointer, "utf8")).trim(), o);
    } catch {}
    return null;
  }

  /** A code repository's project, creating a one-source project if it has none (§4.3). */
  static async ensureForRepo(repo: GitStore, o: { home?: string } = {}): Promise<Project> {
    const pointer = join(repo.turtleDir, PROJECT_POINTER);
    if (existsSync(pointer)) {
      const dir = (await readFile(pointer, "utf8")).trim();
      if (existsSync(join(dir, PROJECT_FILE))) return Project.open(dir, o);
    }
    const top = repo.topLevel;
    if (!top) throw new OpsError("a project needs a repository with a working tree");
    const base = join(o.home ?? turtleHome(), "projects", basename(top));
    let dir = base;
    for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
    return Project.create(dir, { sources: [top], ...(o.home ? { home: o.home } : {}) });
  }

  close(): void {
    this.db.close();
  }

  async addSource(path: string, id?: string): Promise<SourceConfig> {
    const s = await sourceFor(path, this.config.sources, id);
    if (this.config.sources.some((x) => x.path === s.path))
      throw new OpsError(`${s.path} is already a source`);
    this.config.sources.push(s);
    await writeConfig(this.dir, this.config, this.identity, `Add source ${s.id}`);
    await writePointer(s.path, this.dir);
    return s;
  }

  // ------------------------------------------------------------ concepts

  getConcept(id: string): Concept | null {
    return this.db.getConcept(id);
  }

  /** Resolve an id prefix to one concept. */
  resolveConcept(ref: string): Concept {
    const exact = this.db.getConcept(ref);
    if (exact) return exact;
    const found = this.db.findConceptsByPrefix(ref.startsWith("c_") ? ref : `c_${ref}`, 5);
    if (found.length === 1 && found[0]) return found[0];
    if (found.length > 1)
      throw new OpsError(`ambiguous id "${ref}": ${found.map((c) => c.id).join(", ")}`);
    throw new OpsError(`unknown concept: ${ref}`);
  }

  async createConcept(fields: ConceptFields, actor: Actor = this.me): Promise<Concept> {
    const id = `c_${newId()}`;
    const clean = normalizeCreate(fields);
    await this.log.append(actor, [{ kind: "create", id, fields: clean }], () =>
      this.checkCreate(clean),
    );
    return this.db.getConcept(id) as Concept;
  }

  /**
   * Set fields. `base` is the version the actor last saw (default: current). An agent's
   * edit to a field a member changed after `base` is rejected; a member's edit wins.
   */
  async updateConcept(
    id: string,
    fields: Partial<Omit<ConceptFields, "kind">>,
    o: { base?: number; actor?: Actor } = {},
  ): Promise<Concept> {
    const actor = o.actor ?? this.me;
    for (const k of Object.keys(fields)) {
      if (!SET_FIELDS.includes(k as ConceptField)) throw new OpsError(`unknown field: ${k}`);
    }
    const cur = this.requireConcept(id);
    const base = o.base ?? cur.version;
    await this.log.append(actor, [{ kind: "set", id, fields, base }], () => {
      const now = this.requireConcept(id);
      this.checkStale(now, Object.keys(fields) as ConceptField[], base, actor);
      if (fields.parentId) this.checkParent(fields.parentId, id);
      if (fields.dependsOn) this.checkDeps(id, fields.dependsOn);
      if (fields.file !== undefined || fields.script !== undefined) {
        const c = this.requireConcept(id);
        this.checkScript(fields.file ?? c.file, fields.script ?? c.script);
      }
    });
    return this.requireConcept(id);
  }

  async dropConcept(id: string, o: { base?: number; actor?: Actor } = {}): Promise<Concept> {
    const actor = o.actor ?? this.me;
    const cur = this.requireConcept(id);
    await this.log.append(actor, [{ kind: "drop", id, base: o.base ?? cur.version }]);
    return this.requireConcept(id);
  }

  async link(from: string, rel: LinkRel, to: LinkTarget, actor: Actor = this.me): Promise<string> {
    this.requireConcept(from);
    const id = `l_${newId()}`;
    await this.log.append(actor, [{ kind: "link", id, from, rel, to }]);
    return id;
  }

  /** Record a human's answer and the decision it makes (docs/phase2-spec.md §6.2). */
  async answerQuestion(questionId: string, text: string, actor: Actor = this.me): Promise<Concept> {
    const q = this.requireConcept(questionId);
    if (q.kind !== "question") throw new OpsError(`${questionId} is not a question`);
    if (!text.trim()) throw new OpsError("an answer is required");
    const by = actor.type === "member" ? actor.id : actor.onBehalfOf;
    await this.updateConcept(
      q.id,
      { answer: { text: text.trim(), by, at: new Date().toISOString() } },
      { actor },
    );
    const d = await this.createConcept(
      { kind: "decision", parentId: q.parentId, title: text.trim(), body: `Answer to: ${q.title}` },
      actor,
    );
    await this.link(d.id, "provenance", { type: "concept", id: q.id }, actor);
    return d;
  }

  /**
   * Abandon an approach without deleting it (docs/phase2-spec.md §11.1): the task and
   * its unfinished subtasks become `abandoned`, and a lesson is attached to `on`
   * (default: the task's parent). A lesson text written by a member is `confirmed`;
   * a drafted one stays `proposed` until a human confirms it.
   */
  async abandonTask(
    taskId: string,
    o: { lesson?: string; on?: string; actor?: Actor } = {},
  ): Promise<{ task: Concept; lesson: Concept }> {
    const actor = o.actor ?? this.me;
    const task = this.requireConcept(taskId);
    if (task.kind !== "task") throw new OpsError(`${taskId} is not a task`);
    const on = o.on ?? task.parentId;
    if (!on) throw new OpsError("nowhere to attach the lesson");
    this.requireConcept(on);
    const open = (t: Concept) =>
      t.status !== "done" && t.status !== "failed" && t.status !== "dropped";
    const subtree: Concept[] = [];
    const walk = (id: string) => {
      for (const c of this.db.listConcepts({ parentId: id })) {
        if (c.kind === "task") subtree.push(c);
        walk(c.id);
      }
    };
    walk(task.id);
    await this.updateConcept(task.id, { status: "abandoned" }, { actor });
    for (const t of subtree.filter(open))
      await this.updateConcept(t.id, { status: "abandoned" }, { actor });
    const drafted = !o.lesson;
    const lesson = await this.createConcept(
      {
        kind: "lesson",
        parentId: on,
        title: firstLineOf(o.lesson ?? draftLesson(this, task)),
        body: o.lesson ?? draftLesson(this, task),
        lessonState: drafted || actor.type === "agent" ? "proposed" : "confirmed",
      },
      actor,
    );
    await this.link(lesson.id, "provenance", { type: "concept", id: task.id }, actor);
    return { task: this.requireConcept(task.id), lesson };
  }

  /**
   * Try another way under `parentId`: a new sibling task that starts from a checkpoint
   * taken before the abandoned attempts began (default: the parent's newest evidence
   * checkpoint older than its first abandoned child). It receives the lessons in scope
   * through the context assembler.
   */
  async retryTask(
    parentId: string,
    title: string,
    o: {
      body?: string;
      from?: { taskId: string; checkpointId: string } | null;
      actor?: Actor;
    } = {},
  ): Promise<Concept> {
    const parent = this.requireConcept(parentId);
    let from = o.from;
    if (from === undefined) {
      const abandoned = this.db
        .listConcepts({ parentId })
        .filter((c) => c.kind === "task" && c.status === "abandoned")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const before = abandoned[0]?.createdAt;
      const cps = this.db
        .listLinks({ from: parentId, rel: "evidence" })
        .filter((l) => l.to.type === "node" && (!before || l.createdAt <= before));
      const cp = cps.at(-1);
      from = cp && parent.kind === "task" ? { taskId: parent.id, checkpointId: cp.to.id } : null;
    }
    return this.createConcept(
      {
        kind: "task",
        parentId,
        title,
        ...(o.body ? { body: o.body } : {}),
        assignee: { type: "agent" },
        ...(from ? { startFrom: from } : {}),
      },
      o.actor ?? this.me,
    );
  }

  /**
   * A new task next to `taskId` that starts from its latest checkpoint: it reuses that
   * task's files and conversation (e.g. "Model B" from the environment set up for A).
   */
  async taskFromHere(
    taskId: string,
    title: string,
    o: { body?: string; actor?: Actor } = {},
  ): Promise<Concept> {
    const t = this.requireConcept(taskId);
    if (t.kind !== "task") throw new OpsError(`${taskId} is not a task`);
    const cp = this.db
      .listLinks({ from: taskId, rel: "evidence" })
      .filter((l) => l.to.type === "node")
      .at(-1);
    if (!cp) throw new OpsError("this task has no checkpoint to start from yet");
    return this.createConcept(
      {
        kind: "task",
        parentId: t.parentId,
        title,
        ...(o.body ? { body: o.body } : {}),
        assignee: { type: "agent" },
        startFrom: { taskId, checkpointId: cp.to.id },
      },
      o.actor ?? this.me,
    );
  }

  /** Active checks that apply to a concept: those on it and on every ancestor (D31). */
  checksInScope(id: string, states: readonly string[] = ["active"]): Concept[] {
    const out: Concept[] = [];
    let cur = this.db.getConcept(id);
    while (cur) {
      for (const c of this.db.listConcepts({ parentId: cur.id, kind: "check" }))
        if (states.includes(c.checkState ?? "active")) out.push(c);
      cur = cur.parentId ? this.db.getConcept(cur.parentId) : null;
    }
    return out;
  }

  /**
   * A check for the subtree of `on` (architecture §3.7). On a lesson, it applies where the
   * lesson does and links to it with `enforces`. A member's check is active at once; an
   * agent's is proposed until a member activates it.
   */
  async addCheck(
    o: { on: string; title: string; file: string; script: string; body?: string },
    actor: Actor = this.me,
  ): Promise<Concept> {
    const on = this.requireConcept(o.on);
    const lesson = on.kind === "lesson" ? on : null;
    const scope = lesson ? lesson.parentId : on.id;
    if (!scope) throw new OpsError("a check needs a scope");
    const c = await this.createConcept(
      {
        kind: "check",
        parentId: scope,
        title: o.title.trim(),
        ...(o.body ? { body: o.body } : {}),
        file: o.file.trim(),
        script: o.script,
        checkState: actor.type === "agent" ? "proposed" : "active",
      },
      actor,
    );
    if (lesson) await this.link(c.id, "enforces", { type: "concept", id: lesson.id }, actor);
    return c;
  }

  /** Lessons that apply to a concept: those on it and on every ancestor, nearest first. */
  lessonsInScope(id: string): Concept[] {
    const out: Concept[] = [];
    let cur = this.db.getConcept(id);
    while (cur) {
      for (const c of this.db.listConcepts({ parentId: cur.id, kind: "lesson" })) {
        if (c.lessonState !== "superseded") out.push(c);
      }
      cur = cur.parentId ? this.db.getConcept(cur.parentId) : null;
    }
    return out;
  }

  /**
   * Undo the batch containing `opId` with an inverse batch: creates are dropped, sets
   * restore the replaced values, drops are restored, links are removed.
   */
  async undo(opId: string, actor: Actor = this.me): Promise<Operation[]> {
    const op = this.db.getOp(opId);
    if (!op) throw new OpsError(`unknown operation: ${opId}`);
    const batch = this.db.listOps({ batch: op.batch });
    const inverse: Change[] = [];
    for (const o of [...batch].reverse()) {
      const c = o.change;
      const cur = "id" in c ? this.db.getConcept(c.id) : null;
      if (c.kind === "create") inverse.push({ kind: "drop", id: c.id, base: cur?.version ?? 0 });
      else if (c.kind === "set")
        inverse.push({
          kind: "set",
          id: c.id,
          fields: (o.prev ?? {}) as Partial<Omit<ConceptFields, "kind">>,
          base: cur?.version ?? 0,
        });
      else if (c.kind === "drop") inverse.push({ kind: "restore", id: c.id });
      else if (c.kind === "restore")
        inverse.push({ kind: "drop", id: c.id, base: cur?.version ?? 0 });
      else if (c.kind === "link") inverse.push({ kind: "unlink", id: c.id });
    }
    if (!inverse.length) throw new OpsError("nothing to undo");
    return this.log.append(actor, inverse);
  }

  async rebuild(): Promise<number> {
    return rebuild(this.store, this.db);
  }

  // ------------------------------------------------------------- checks

  private requireConcept(id: string): Concept {
    const c = this.db.getConcept(id);
    if (!c) throw new OpsError(`unknown concept: ${id}`);
    return c;
  }

  private checkCreate(f: ConceptFields): void {
    if (!CONCEPT_KINDS.includes(f.kind)) throw new OpsError(`unknown kind: ${f.kind}`);
    if (!f.title.trim()) throw new OpsError("a title is required");
    if (f.kind === "goal" && f.parentId) throw new OpsError("a goal has no parent");
    if (f.kind !== "goal" && !f.parentId) throw new OpsError(`a ${f.kind} needs a parent`);
    if (f.parentId) this.checkParent(f.parentId, null);
    for (const d of f.dependsOn ?? []) {
      const t = this.db.getConcept(d);
      if (t?.kind !== "task") throw new OpsError(`dependency ${d} is not a task`);
    }
    if (f.kind === "check") this.checkScript(f.file, f.script);
  }

  private checkScript(file: string | undefined, script: string | undefined): void {
    if (!file || !CHECK_FILE.test(file))
      throw new OpsError("a check needs a file name ending in .py, .sh, .js or .mjs");
    if (!script?.trim()) throw new OpsError("a check needs a script");
    if (script.length > MAX_CHECK_SCRIPT) throw new OpsError("the check script is too long");
  }

  /** Dependencies are tasks, and following them never leads back to `self`. */
  private checkDeps(self: string, deps: readonly string[]): void {
    const seen = new Set<string>();
    const stack = [...deps];
    for (const d of deps)
      if (this.db.getConcept(d)?.kind !== "task")
        throw new OpsError(`dependency ${d} is not a task`);
    while (stack.length) {
      const d = stack.pop() as string;
      if (d === self) throw new OpsError("that dependency would make a cycle");
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(this.db.getConcept(d)?.dependsOn ?? []));
    }
  }

  private checkParent(parentId: string, self: string | null): void {
    let cur = this.db.getConcept(parentId);
    if (!cur) throw new OpsError(`unknown parent: ${parentId}`);
    while (cur) {
      if (cur.id === self) throw new OpsError("a concept cannot be moved under itself");
      cur = cur.parentId ? this.db.getConcept(cur.parentId) : null;
    }
  }

  private checkStale(cur: Concept, fields: ConceptField[], base: number, actor: Actor): void {
    if (actor.type !== "agent") return;
    const changed = fields.filter((f) => {
      const m = cur.fieldMeta[f];
      return m && m.v > base && m.by.type === "member";
    });
    if (changed.length) {
      const by = cur.fieldMeta[changed[0] as ConceptField]?.by.id ?? "a member";
      throw new StaleEditError(cur.id, changed, by);
    }
  }
}

function normalizeCreate(f: ConceptFields): ConceptFields {
  const out: ConceptFields = { ...f, title: f.title.trim(), parentId: f.parentId ?? null };
  if (out.kind === "task") {
    out.status ??= "todo";
    out.dependsOn ??= [];
  }
  return out;
}

async function sourceFor(
  path: string,
  existing: SourceConfig[],
  id?: string,
): Promise<SourceConfig> {
  let store: GitStore;
  try {
    store = await GitStore.open(path);
  } catch {
    throw new OpsError(`not a git repository: ${path}`);
  }
  const top = store.topLevel;
  if (!top) throw new OpsError(`a source needs a working tree: ${path}`);
  let sid = (id ?? basename(top)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "source";
  const base = sid;
  for (let i = 2; existing.some((s) => s.id === sid); i++) sid = `${base}-${i}`;
  return { id: sid, kind: "git", path: top };
}

async function writeConfig(
  root: string,
  config: ProjectConfig,
  id: MemberIdentity,
  message: string,
): Promise<void> {
  await writeFile(join(root, PROJECT_FILE), `${JSON.stringify(config, null, 2)}\n`);
  const env = {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: `${id.memberId}@turtle.invalid`,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: `${id.memberId}@turtle.invalid`,
  };
  await git(["add", PROJECT_FILE], { cwd: root });
  await git(["commit", "-q", "--allow-empty", "-m", message, "--", PROJECT_FILE], {
    cwd: root,
    env,
  });
}

async function writePointer(sourcePath: string, projectDir: string): Promise<void> {
  const store = await GitStore.open(sourcePath);
  await mkdir(store.turtleDir, { recursive: true });
  await writeFile(join(store.turtleDir, PROJECT_POINTER), `${projectDir}\n`);
}

export type { ConceptKind };

function firstLineOf(s: string): string {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > 100 ? `${line.slice(0, 99)}…` : line || "Lesson";
}

/** A plain draft of what an abandoned task teaches (no model call). */
function draftLesson(p: Project, task: Concept): string {
  const findings = p.db
    .listConcepts({ parentId: task.id, kind: "finding" })
    .map((f) => `- ${f.title}`);
  const decisions = p.db
    .listConcepts({ parentId: task.id, kind: "decision" })
    .map((d) => `- decided: ${d.title}`);
  const lines = [`"${task.title}" was abandoned; do not repeat it as it was.`];
  if (findings.length || decisions.length)
    lines.push("", "What it found:", ...findings, ...decisions);
  if (task.brief) lines.push("", "Its last brief:", task.brief);
  return lines.join("\n");
}
