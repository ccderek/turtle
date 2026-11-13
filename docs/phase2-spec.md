# turtle — Phase 2 Spec: Task Graph (single user)

> Status: draft for review. Builds on [phase1-spec.md](./phase1-spec.md); architecture in [architecture.md](./architecture.md) v0.3 (§2.1, §3.1–§3.5). Items marked **VERIFY** are assumptions about external tools to confirm during implementation.

## 1. Goal

Phase 2 makes the **task graph** the product. A human states a goal; agents split it into tasks and work on them. The graph is a **faithful, rewindable and shareable record** of that work. The human reads it when they want, goes back to any point, and shares any part. They are notified, not asked: only real questions need them. It is single-user, but every stored object is already multi-user-shaped (actors, replicas, an operation log), so Phase 4 adds sync without migrating data.

### Questions Phase 2 must answer (the gate for Phase 4)

Measured passively from what turtle records; nothing asks the human to perform.

| # | Question | Measured by | Target |
|---|---|---|---|
| G1 | **Rewindable:** can work restart from any point? | Share of checkpoints with a resume point. Success rate of "new task from here" (files and conversation restored; the agent continues without re-doing finished steps) | ≥ 95 % of declared checkpoints resumable; forks succeed in ≥ 9 of 10 tries |
| G2 | **Truthful:** does the graph match what happened? | Share of findings and `done` tasks with evidence links, plus an audit model's agreement between each task's graph entries and its tool log | ≥ 90 % evidenced; ≥ 85 % audit agreement |
| G3 | **Shareable:** does an exported brief stand on its own? | The user judges 3 exports of real tasks: is the goal clear, are the results and decisions with evidence clear, are the open questions clear? Optional proxy: a model answers the same 4 questions from the export alone | 3 of 3 judged clear; no secrets or home paths in any export |
| G4 | **Affordable:** what does the record cost? | Tokens per finished task, graph-tool share of tokens, repeated-work rate | Reported (baseline for Phase 3); graph tools < 5 % of tokens |
| G5 | **Reproducible** (added with hardening, architecture §3.7): do hardened steps redo themselves? | Recipes verified by a clean replay, replays that needed no model, check failures caught and then fixed | Reported (not gated in Phase 2) |

Also recorded, not gated: redirect latency (instruction sent → delivered at the next tool boundary).

### Non-goals (later phases)

| Phase | Deferred work |
|---|---|
| 3 | Resource locks and queues; output store management; merging code from several upstream branches; explore and the compare view |
| 4 | Sync between replicas; role enforcement |
| 5 | Live share links and comments from people without turtle |

Phase 2 *records* resources and outputs, so the data is there when those phases start.

## 2. User workflow

```bash
turtle project create ~/projects/perf-lab --source ~/src/scripts --source ~/src/models
cd ~/projects/perf-lab && turtle ui
```

Single-repo users need nothing new: `turtle init` in a code repository creates a one-source project automatically (§4.3).

In the UI:

1. **Write a goal.** For example: "Measure power and performance of model A on the phone, then model B."
2. **The agent splits it into tasks.** The first agent (the *planner*) runs on the goal and creates tasks with `turtle_task`. New tasks are flagged **new**, and the *Activity* feed gets one batched entry ("α added 4 tasks"). Nothing waits for your approval. Tasks without unmet dependencies start at once, up to the parallelism cap; the others wait.
3. **Look when you want.** Cards change status live; findings, decisions and questions appear under their tasks. *Needs you* holds only what is really blocked on you: questions, blocked or failed tasks, and budget limits.
4. **Answer, redirect, edit.**
   - A question shows in *Needs you*.
   - "Tell the agent…" on a running task reaches it at its next tool boundary.
   - Editing a task's text, dropping it or pausing it tells its agent too.
5. **Add your own tasks**, for example "Model B, starting from *Environment*".
6. **Open any task** to see its brief, evidence, conversation and code changes; export the brief as a page to share.

## 3. Process architecture

Unchanged from Phase 1 except for scope:

- `turtle ui` serves a **project** instead of a repository. It is also the orchestrator (D13) and now runs a minimal **scheduler** (§9).
- `turtle run` in a source repository still works. It creates a task in that repository's project.
- Every process writes concepts through the same operation log (§5), so CLI and UI writers interleave safely.

```
browser ──HTTP/SSE──▶ turtle ui (project) ── scheduler ── RunSession × N ──▶ runners
                          │                        │
                          ├─ project repo: ops (git objects) + project.db (SQLite view)
                          └─ sources: repo A, repo B (each with its code-layer engine, Phase 0)
```

## 4. Projects and sources

### 4.1 On disk

```
~/projects/perf-lab/                 a normal git repository (the project)
├── turtle-project.json              name, sources, resources, defaults (committed)
└── .git/
    ├── refs/turtle/ops/<member>/<replica>   operation log (§5)
    └── turtle/
        ├── project.db               SQLite materialized view (rebuildable)
        ├── run/ logs/               as in Phase 0
        └── seen.json                per-member UI state (not synced)
~/.turtle/identity.json              { memberId, name, replicaId }   (one per machine)
~/.turtle/workspaces/<project>/<task>/<source>/   materialized sources per task
```

`turtle-project.json`:

```json
{
  "name": "perf-lab",
  "sources": [
    { "id": "scripts", "kind": "git", "path": "/Users/derek/src/scripts" },
    { "id": "models",  "kind": "git", "path": "/Users/derek/src/models" }
  ],
  "resources": [{ "id": "pixel-1", "name": "Pixel-1", "kind": "device" }],
  "defaults": { "sandbox": "none", "model": "claude-opus-5-5", "maxParallel": 3, "maxBudgetUsd": 10 }
}
```

- **Paths are local in Phase 2.** A source also takes an optional `url`, which Phase 4 uses to locate the clone on another machine.
- **Code stays with code.** Snapshots, refs (`refs/turtle/branches/*`) and the per-source index live in each source repository, exactly as in Phase 0. The project records only commit ids.

### 4.2 Identity

The first run creates `~/.turtle/identity.json`:

| Field | Value |
|---|---|
| `memberId` | `m_` + a random id |
| `name` | git `user.name` |
| `replicaId` | a random id per machine |

Agents act as `{ type: "agent", id, onBehalfOf: memberId }` (D26). Nothing about identity leaves the machine in Phase 2.

### 4.3 Compatibility with Phase 0–1 repositories

- **`turtle init` in a code repository with no project** creates a project at `~/.turtle/projects/<repo-name>`, with that repository as its only source. It writes the pointer `.git/turtle/project` (the project path), so every command run inside the repository finds the project.
- **Migration.** On first open, existing branches become tasks under a goal "Imported runs":
  - one task per branch;
  - a fork becomes a task whose `startFrom` is its fork node;
  - `need_decision` / `blocked` heads become question / blocked tasks.
  
  Migration is one batch of operations, so it is undoable like anything else.

## 5. Operation log

All concept changes are **operations** (architecture §3.5). The SQLite tables are a cache rebuilt from them (`turtle doctor --rebuild`).

```ts
interface Operation {
  id: string;                     // sha256 of the canonical JSON below (without id)
  replica: string;                // `${memberId}/${replicaId}`
  actor: { type: "member"; id: string } | { type: "agent"; id: string; onBehalfOf: string };
  seq: number;                    // per replica, 1, 2, 3…
  deps: Record<string, number>;   // version vector: highest seq seen per replica (causality)
  at: string;
  change:
    | { kind: "create"; concept: ConceptFields }
    | { kind: "set"; id: string; fields: Partial<ConceptFields>; base: number }  // base = version the actor saw
    | { kind: "drop"; id: string; base: number }
    | { kind: "link"; from: string; to: LinkTarget; rel: "evidence" | "provenance" | "reuses" }
    | { kind: "seen"; ids: string[] };   // never stored in the log: local UI state only
}
```

- **Storage.** Operations are batched (one user action, or up to 250 ms of agent operations) into a commit on `refs/turtle/ops/<member>/<replica>`. Each commit holds the batch as `ops.jsonl` and has the previous batch as its parent. The ref only moves forward, with CAS as in Phase 0.
  - Committed operations are mirrored into `project.db` in the same step. Order: insert rows, then move the ref; the reconcile rule from Phase 1 §3.1 also applies here.
- **Ordering.** Replay order is causal order (version vectors), with ties broken by `(at, replica, seq)`. With one replica this is just the order written.
- **Concurrent writers on one machine** (UI process, CLI, agents) share one replica. They take a file lock on `.git/turtle/ops.lock` around "read seq → append → commit".
- **Edits based on stale state.** A `set` or `drop` whose `base` is older than the concept's current version is checked field by field. A field changed since `base` by a **member** rejects an **agent** operation: the tool call returns "derek changed this; re-read with turtle_graph". A member's operation on stale state wins, and the replaced value stays in history. In Phase 4 the same check turns concurrent member edits into surfaced conflicts.
- **Undo.** Any batch can be reverted by an inverse batch (`turtle undo <op>` and in the UI history).

## 6. Concepts

### 6.1 Fields

```ts
interface ConceptFields {
  id: string;                      // c_ + random
  kind: "goal" | "task" | "finding" | "decision" | "question" | "output" | "lesson";
  parentId: string | null;
  title: string;                   // one line
  body: string;                    // markdown
  // task
  status?: "todo" | "running" | "paused" | "need_decision" | "blocked" | "done" | "failed" | "abandoned" | "dropped";
  assignee?: { type: "agent" } | { type: "member"; id: string } | null;   // agent = turtle starts one
  dependsOn?: string[];
  sources?: string[];              // source ids the task works in; default: all
  resources?: string[];            // recorded only in Phase 2 (no locks)
  startFrom?: { taskId: string; checkpointId: string } | null;
  // question
  options?: string[];
  answer?: { text: string; by: string; at: string } | null;
  // output
  path?: string; sha256?: string; size?: number;
  // lesson: applies to the subtree of parentId
  lessonState?: "proposed" | "confirmed" | "superseded";
  // shared
  brief?: string;                  // task only: the living summary (§10)
  order?: string;                  // fractional index among siblings
}
```

The current version of a concept is the number of operations applied to it.

### 6.2 Status rules

| Status | Set by |
|---|---|
| `todo` → `running` | The scheduler when the task's agent starts |
| `running` → `need_decision` | A `turtle_question`, or a checkpoint with status `need_decision` |
| `need_decision` → `running` | The human's answer: the answer is written to the question, a `decision` concept is created (author: the member), and the agent continues |
| `running` → `done` / `blocked` / `failed` | The run's outcome (Phase 0 `EndReason`) |
| `running` → `paused` | A human pause. The agent is interrupted; resuming continues the branch |
| any → `abandoned` | A human abandons an approach (§11.1). The record stays, the task is shown struck through, and a lesson is drafted |
| any → `dropped` | A human drop. A running agent is stopped |

`done` requires at least one evidence link (a checkpoint at minimum). A task finished without any is shown as **claimed**.

### 6.3 Links

| `rel` | Meaning |
|---|---|
| `evidence` | Concept → checkpoint, artifact, output or test result |
| `provenance` | Finding/decision → the tool call or message it came from |
| `reuses` | Task → the task whose checkpoint it starts from |

`LinkTarget` is `{ type: "checkpoint" | "artifact" | "output" | "concept" | "message", id }`.

## 7. Tasks and the code layer

### 7.1 Workspaces and multi-source checkpoints

- **One source** (the usual case and every Phase 0–1 repository): the workspace is the materialized source itself, exactly as in Phase 0, so the agent's cwd is the repository root.
- **Several sources:** the workspace is `~/.turtle/workspaces/<project>/<task>/`, with one subdirectory per source the task uses (`scripts/`, `models/`). The agent's cwd is that directory, and the system prompt lists the subdirectories.
- **Primary and companions (as built in M3).** The repository the run is driven from is the *primary* source. It keeps the conversation, resume points and summaries, exactly as in Phase 0. Every other source is a *companion* (`core/run/companion.ts`) with its own branch in its own repository.
  - At every primary node, companions are snapshotted first. A change in any source makes a checkpoint: a micro snapshot is taken even when only a companion changed.
  - A semantic checkpoint always includes every companion.
  - Companion nodes carry the trailer `Turtle-Checkpoint: <primary node id>`, and the primary node's `checkpoint` event lists the parts.
  - **The checkpoint id is the primary node id.** Its full state is resolved by walking the primary's ancestors and taking, for each companion, the nearest part recorded (`resolveCheckpointParts`). A micro checkpoint records only the sources that changed.
  - **Stats are combined.** Rules, automatic summaries and the agent's `turtle_diff` see all sources, with paths prefixed by the source directory (`models/m.txt`).
- **A branch keeps its layout.** A branch created single-source continues single-source even after the project gains sources; a new run or a fork picks up all sources.
  - **Continue:** companion branches are found from the primary branch's `run_start` events.
  - **Fork:** each companion forks from its part at the fork checkpoint.
- **Live-writer marking.** Each companion branch gets an agent row (adapter `companion`, the orchestrator's pid), so a reconcile in another process leaves it alone.
- **Not yet multi-source:** `turtle export` and the Phase 1 code view work on the primary source only, until M7/M8.

### 7.2 Starting a task

| Task has | The run is |
|---|---|
| no `startFrom`, never ran | **new**: each source branches from its working copy (as Phase 0 `new`; `fromHead` per project default) |
| `startFrom` | **fork** from that checkpoint, resuming the conversation at its resume point (Phase 0 fork) |
| a branch already (answered, resumed, unpaused) | **continue** that branch |

The prompt is assembled by the **context assembler** and kept compact:
- the task's title and body;
- the goal;
- decisions on its ancestors;
- the findings and outputs of the tasks it depends on (titles + one line each, with paths);
- **the lessons in scope**: every non-superseded lesson on the task's ancestors, with where it came from ("from the abandoned *Approach A*");
- the tool contract (§8).

A forked task already carries its conversation, so it receives only what changed since its fork point.

## 8. Agent tools (MCP server `turtle`)

The tools are added to runner-claude's MCP server and to the protocol as new request kinds. Each is a small structured call; replies are one or two lines, to keep G4 low.

| Tool | Input | Effect |
|---|---|---|
| `turtle_checkpoint` | as Phase 0, plus optional `findings: {text, evidence?}[]` | Checkpoint of all sources; creates the findings with evidence → this checkpoint |
| `turtle_task` | `{ op: "create" \| "update", id?, parentId?, title, body?, dependsOn?, startFrom?: "here" \| checkpointId, sources?, status?: "done" \| "blocked" }` | Creates a subtask (auto-starts per §9) or updates the agent's own tasks. `startFrom: "here"` = this agent's latest checkpoint |
| `turtle_finding` | `{ text, evidence?: [{ type, id \| path }] }` | A finding under the current task. Paths become outputs (path + sha256 computed by the orchestrator) |
| `turtle_decision` | `{ text, rationale? }` | A decision the agent made, so pivots are visible |
| `turtle_question` | `{ text, options? }` | A question; the task becomes `need_decision`; the reply tells the agent to end its turn |
| `turtle_brief` | `{ text }` | Replaces the task's brief (§10) |
| `turtle_lesson` | `{ text, evidence? }` | Proposes a lesson on the parent of the current task (state `proposed` until a human confirms it) |
| `turtle_graph` | `{ scope?: "task" \| "goal" }` | Compact text view of the relevant graph: own task, siblings' status, dependency findings, decisions, lessons in scope. Default `task` |

System prompt additions (draft):

> You are working on one task in a shared task graph that a human watches. Record what you learn with turtle_finding (attach evidence: a file you wrote, a command's output saved to a file, a checkpoint). Ask with turtle_question only when a human must decide. Split work with turtle_task only when parts can run independently or need a different start. Keep the brief current with turtle_brief at each checkpoint: status first, then conclusions with evidence, then open questions. Instructions from the human may arrive between tool calls marked "[from derek]": follow them.

As built (M4):
- **Protocol.** The tools are one protocol request, `kind: "graph"` with an `op`. They are only exposed when the run belongs to a task (`RunnerStartOptions.graphTools`), so plain runs pay no token cost for them.
- **Binding.** `RunSession` knows nothing about projects. It forwards graph requests and its lifecycle (start, semantic checkpoint, end) to a `TaskBinding`; `TaskRunBinding` in `core/project/task-run.ts` implements it.
- **Evidence.** A file path becomes an `output` concept (path, sha256, size) linked as evidence. A finding without evidence is linked to the current node as provenance and is shown as claimed.
- **Brief reminder.** A checkpoint's reply reminds the agent to update the brief when it has not done so in this run.
- **Starting a task** (`startTaskRun`, `turtle task start`):
  - continue the task's idle branch, whose prompt is the instruction (or the answers given since the last checkpoint) plus the lessons in force;
  - fork from `startFrom`;
  - or start new.
- **The task follows the run.** At the end, the task's status follows the run's outcome; an unanswered question makes it `need_decision`.

Guards:
- **Caps on what an agent may create.**
  - At most 8 tasks per run (built per run, not per turn).
  - At most depth 3 below the agent's own task.
  - At most 20 findings per checkpoint.
  - Excess calls return an error explaining the cap.
- **Scope of edits.** An agent may only `update` tasks it created or is assigned to.

## 9. Scheduler (minimal) and notifications

The scheduler runs inside `turtle ui` (the long-lived orchestrator). It reacts to every concept change, and also wakes every 5 s.

1. **Ready tasks.** A task is *ready* when it is `todo`, assigned to an agent, not paused, and every `dependsOn` task is `done`.
2. **Starting.** Ready tasks start in creation order, while running agents < `maxParallel` (default 3). The project budget also applies: the sum of running agents' budgets ≤ `maxBudgetUsd × maxParallel`.
3. **Queued tasks show why** they wait: "waiting for *Compile A*", "parallel cap 3/3", "paused".
4. **Without `turtle ui`, nothing auto-starts.** `turtle task start <id>` and `turtle run` still work. A background daemon is Phase 3.

Notifications (D21): inform, never ask.
- **New marks.** Nodes created by agents carry `new` until the member opens them or marks all seen (`seen.json`, local).
- **Activity feed, not *Needs you*.** One entry per agent turn ("α added 3 tasks, 2 findings"). *Needs you* is reserved for what blocks on the human: questions, blocked or failed tasks, budget limits.
- **Pause and Drop stay one click away** on a new task's card and its feed entry, for when the human disagrees.

**As built (M5 + first UI).** `TaskRunner` in `packages/server/src/tasks.ts` runs tasks in the `turtle ui` process. A task is ready when it is `todo`, assigned to an agent, its dependencies are `done`, and no ancestor task is inactive (paused, dropped, abandoned). It starts ready tasks in creation order up to `maxParallel` (default 3) on every graph change and every 5 s. *Auto-start* is a toggle in the toolbar (`defaults.autoStart`, default on). With it off, tasks start only with **Start**. A new goal gets a planner task (`role: "planner"`, when `defaults.planOnGoal` is not false and "Let a planner agent split it into tasks" is ticked). The planner's tasks then start as their dependencies finish. Answering the last open question of a task continues that task at once. The budget cap and per-turn batching of Activity entries are not built yet. Activity lists one entry per operation, and repeated identical entries are folded.

## 10. Briefs and export

- **What a brief is.** The agent keeps it current with `turtle_brief`, at least at every semantic checkpoint. The system prompt asks; the orchestrator reminds in the checkpoint reply if the brief is older than the last two checkpoints.
- **Fallback.** If a task ends with no brief, a brief is assembled from its findings, decisions and last checkpoint summary (no model call).
- **Export.** "Export" on a task or goal writes one self-contained HTML file: the subtree's briefs, findings with evidence (artifacts inlined when under 1 MB, outputs by path and sha256), decisions and status. It never includes transcripts, environment variables or the member's home path (`/Users/derek/...` becomes `~/...`). A preview shows exactly what is included before writing.

## 11. Steering: redirect, edit, pause, drop

| Human action | Delivery to the running agent |
|---|---|
| **Tell the agent…** (free text) | Queued as an `instruction` event in the source's SQLite (any process can queue one). The run picks it up at its next tool boundary and sends it into the SDK's streaming input as a **genuine user message**, the user's own words without a wrapper. Claude Code absorbs it mid-turn ("the user sent a new message while you were working"). If it arrives as the agent ends its turn, it starts one more turn. **Verified live (M5):** text returned through PostToolUse `additionalContext` is attached to a tool result, and the model rightly ignores it as possible prompt injection. A relayed "X says: …" wrapper was rejected too. The verbatim user message was followed |
| Edit the task's title/body/dependencies | An instruction is generated: "derek changed this task: <diff>" |
| Pause | Interrupt (Phase 0); status `paused`; resume = continue the branch with "resumed by derek" |
| Drop | Interrupt; status `dropped`; work is kept as a `killed` checkpoint |
| Answer a question | As in Phase 1 (continue), plus the decision concept |

Every delivery is an event (`instruction_queued`, `instruction_delivered` with the tool-use id), which gives G3.

**Stop requests travel the same way.** A `stop_request` event is seen by the run at its next tool boundary, so `turtle task pause` works for runs in any process. Runs with a pid file are also signalled at once.

### 11.1 Abandon and retry (D28)

| Step | What turtle does |
|---|---|
| **Abandon** *Approach A* | The task becomes `abandoned` (running agents are stopped). Subtasks, code and data are kept |
| **Draft the lesson** | A `lesson` concept (state `proposed`), whose parent is the node the human rewinds to (default: A's parent). The body is drafted from A's findings, failed checks and last checkpoint summary, using the summarizer model when available and a plain template otherwise. Provenance links point to A and its evidence |
| **Edit / confirm** | The human edits the text and confirms it (`confirmed`) |
| **Retry** | A new sibling task *Approach B* with `startFrom` = a checkpoint of the parent taken before A started (by default the last checkpoint of the parent's branch older than A's first). Its files and conversation go back to that point, so it carries no A transcript. The context assembler injects the lessons in scope |
| **Audit** | At each semantic checkpoint of B, the audit (§15, G2) also checks B's tool log and diff against each injected lesson. A violation is a finding marked `contradicts lesson`, and it goes to *Needs you* |

CLI: `turtle task abandon <task> [--lesson "<text>"] [--on <node>]` and `turtle task retry <node> "<title>" [--from <checkpoint>]`. UI: **Abandon…** on a task opens the drafted lesson for editing; **Try another way from here** on the parent.

### 11.2 Checks: hardened lessons (M7.5, architecture §3.7, D31)

A lesson in the prompt is advice. A **check** is a script turtle runs, so a lesson that can be tested becomes a rule.

| Part | As built |
|---|---|
| **Concept** | Kind `check`, with `file` (`check_oos.py`: the extension picks python3, bash or node), `script`, and `checkState` (`proposed`, `active` or `retired`). Its parent is its scope: every task under it is judged. A check made on a lesson goes on the lesson's node and links to the lesson with `enforces` |
| **Where it runs** | `runScript` (core `run/script.ts`) writes the script and the `turtle_check.py` helpers to a fresh temporary directory, outside the workspace, and runs it with the task's working directory as cwd, **in the agent's sandbox**: on the host (`none`, environment variables that look like credentials removed) or in the runner image (`docker run --rm --user … -v <workspace>:/workspace -v <script dir>:/turtle-script:ro`). Checks have a 60 s timeout; output is clipped to 4 KB. Exit code 0 passes. The agent cannot edit or delete a check: it lives in the graph |
| **When** | At every semantic checkpoint of a task (declared or automatic, except killed or failed ones), every active check in scope runs, and the results go on the task (`checkResults`, per check: ok, output, checkpoint, time). **Run checks now** in the panel (`POST /api/tasks/:id/checks`, or `turtle check run`) runs them in the task's workspace when it is not running |
| **Enforcement** | The checkpoint's reply lists the failures ("1 of 1 check(s) FAILED … fix the work and checkpoint again"), so the agent can fix the work in the same run. A run that ends `done` while a check fails on its last checkpoint leaves the task `blocked`, which puts it in *Needs you*. Activity reports "checks on X: n failed" |
| **Prompt** | The task prompt has a "Checks that must pass" section with each script (clipped) and whether it passed last time; the system prompt says to fix the work, not the check |
| **Who** | A member's check is active at once (UI: **Enforce with a check…** on a lesson, **Add a check…** on a task; `POST /api/checks`; `turtle check add <lesson|task|goal> --script <file>`). An agent proposes one with `mcp__turtle__check` (on its task, or on a lesson in its scope); it waits in *Needs you* as "Check to activate" and runs only after a member activates it: acceptance conditions are set by people |
| **UI** | Checks are nodes on the map (teal, right after lessons). A task card shows "✓ checks" or "✗ n checks". The task panel's *Checks* section shows each result with its output. The check panel shows the script, Activate / Retire / Edit, and results per task |
| **Demo** | The seeded lesson "keep 6 months out of sample" has `check_oos.py`. Approach B's first done checkpoint fails it; the demo agent reads the reply, adds the out-of-sample score, checkpoints again and passes |

**Helpers.** Every script can `from turtle_check import *`: `read_csv(path)`, `column(rows, name)`, `mean(xs)`, `within(actual, expected, rel=0.03, abs_tol=0)`, `expect(cond, msg)`, `expect_within(actual, expected, rel, what=)`, `param(name)`, `done()` (exit 1 with the problems, or 0).

### 11.3 Recipes and replay (M7.6, architecture §3.7 L2)

| Part | As built |
|---|---|
| **Concept** | Kind `recipe`, under its task: `file`, `script`, `params` (defaults, upper-case names, passed as environment variables), `outputs` (paths, `${NAME}` expanded), `tolerance` (relative, for numbers in .csv/.tsv), `recipeState` (`draft`, `verifying`, `verified`, `failed`) and `verification` (ok, checkpoint, output, problems, time) |
| **Recording** | Agents: `mcp__turtle__recipe` (the system prompt asks for one when a step could be redone). Members: **Add a recipe…** in the task panel, `POST /api/recipes`, `turtle recipe add <task> --script … --param MODEL=A --output 'build/model-${MODEL}.bin' [--tolerance 0.03]` |
| **Verification** | `verifyRecipe` (core `project/recipes.ts`): materialize the task's latest checkpoint in a temporary directory, delete the outputs, run the recipe with its defaults (30 min timeout, agent's sandbox), compare outputs (`compareOutput`: equal bytes, or same table shape with equal text and numbers within the tolerance), run the checks in scope. `turtle ui` verifies draft recipes when the run that recorded them ends; **Verify** / `POST /api/recipes/:id/verify` / `turtle recipe verify` do it on demand. A verified recipe marks its task **⚙ hardened** on the map |
| **Replay** | **Replay with…** / `POST /api/recipes/:id/replay {params}` / `turtle recipe replay <recipe> --param MODEL=B` creates a sibling task "<task> (MODEL=B)" with `startFrom` = the verified checkpoint and `replay` = {recipe, params}. Its first run uses `recipeLauncher`: a scripted runner (no model, no session, no cost) that deletes the outputs, runs the recipe in the forked workspace, records the command and its output as a Bash step, and checkpoints `done` or `blocked`. Checks in scope run at that checkpoint as usual |
| **Repair** | When the recipe fails and auto-start is on, the task runs once more with the real agent (`replay.repairs` counts it). The branch has no conversation to resume, so the agent gets the full task prompt with a "## Replay" section: the parameters, the recipe, and the failure output, and the instruction to fix only what fails and record the updated recipe. That recipe is verified when the run ends. With auto-start off, **Continue** does the same |
| **Demo** | In the phone scenario, *Compile model A* and *Measure power and performance* record recipes (`compile.sh`, exact; `measure.py`, 3% tolerance over 1% noise) and both verify. **Replay with… MODEL=B** fails ("cannot lower Conv3D"), the demo agent changes only `build/compile.sh`, and the new recipe verifies |

Not built yet: recipes in multi-source projects; replaying a chain of recipes (compile → measure) as one action; comparing a replay's outputs with the original's (e.g. power of B vs A) as a check.

## 12. UI

The mind map becomes the home screen; the Phase 1 tree becomes the **Code** tab of a task (filtered to its checkpoints) and a global Code view.

| Area | Content |
|---|---|
| Top bar | Project, goal switcher, running / needs-you / cost, parallel cap, **Code** view toggle |
| Left | *Needs you* (questions, blocked, failed, budget only), *Activity* (batched new tasks, findings, decisions), running agents, sources |
| Center | Mind map (as in the prototype): goal → tasks → children (findings, decisions, questions, outputs, subtasks); collapse per node; dependency arrows on hover; `new` badges; status colors; "waiting for …" lines |
| Right (task) | Brief; facts (agent, status, depends, sources, start point); question box; **Tell the agent…**; findings with evidence (claimed vs evidenced); decisions; tabs: Conversation (live), Code (checkpoints + diffs), Outputs; actions: Pause, Drop, Start now, New task from here, Export |
| Inline edits | Title and body editable in place; "＋" on a card adds a child task; drag to reorder siblings; a dependency picker |

**As built (first version, with M5).** The home screen is the **Tasks** tab when a project is open; **Code** is the Phase 1 view. Left: *Needs you* (open questions, proposed lessons, blocked and failed tasks) and *Activity* (newest first; `new` until "mark seen", stored per browser). Center: one block per goal, with an **outline mind map**: indented cards with guide lines and fold arrows; tasks show status, "by agent/you", `from <checkpoint>` for rewinds, the brief's first line or "waiting for …"; findings, decisions, questions, outputs and lessons are compact leaves. Right: the concept panel: title and body edited in place (editing a running task tells the agent what changed); brief; facts (done by, after, starts from, code branch, which opens the Code tab); **Tell the agent**, **Pause**, **Drop** while running; **Start** / **Continue** otherwise; **Abandon…** with an optional lesson text; **Try another way**; add a subtask; lessons in force; the question box with the agent's options; lesson confirm / supersede; children; history with undo. Toolbar: **New goal**, *Auto-start ready tasks* (n/max running), *Show dropped*. The page polls `GET /api/graph?since=` on every SSE `change`. **As built (M7).**
- **Map layout (the default).** Each goal is a horizontal tidy tree (`web/src/tasks/map.ts`): depth grows to the right, every subtree gets its own vertical band so cards never overlap, and a parent sits at the middle of its children. Tasks are cards with a status stripe, the brief's first line or "waiting for …", `from <checkpoint>` for rewinds, and counts of what is not drawn ("2 findings · 1 output"). Lessons and open questions are small nodes of their own, because they change what happens next. A card with subtasks folds (−/+), and ＋ on a card selects it with the cursor in "Add a subtask". **Dependencies** are dashed arrows from the task that must finish to the one that waits; arrows on one card fan out, and those of the card under the pointer (or selected) are highlighted. *Outline* stays as a toggle (remembered per browser) and is the only layout at phone width.
- **Task panel tabs.** *Overview* (as above, plus a dependency picker: "+ wait for a task" lists tasks of the same goal that would not make a cycle, and × removes one; the server rejects cycles too). *Conversation*: every run on the task's branch, oldest first, with its prompt and the live transcript (the Phase 1 component). *Outputs*: each output with its content from `GET /api/outputs/:id`, CSV as a table, the findings it is evidence for, and where it was read from. *Code*: the task's checkpoints, newest first, and its start point; each opens in the Code tab.
- **New task from here** on a task with a checkpoint: a sibling that starts from that task's latest checkpoint, so it reuses its files and conversation ("Model B" from the environment set up for A).
- **Demo planner.** For a goal that mentions a phone, power or a device, the demo planner creates the phone scenario of architecture §3.1: environment, compile and test plan in parallel, a trace after the environment, and measuring after all three, which asks for the power monitor's sampling rate. `scripts/ui-smoke-tasks.mjs` drives it end to end: the plan, the parallel start, the question, the CSV in *Outputs*, the conversation and checkpoints, "Model B" from a checkpoint, abandoning it into a lesson, the outline, dark mode and phone width.
- **Not built:** drag to reorder siblings, dependency arrows across goals, zoom and pan beyond scrolling, export (M8).

Live updates use the Phase 1 SSE `change` channel; the task view refetches the graph on each change.

## 13. HTTP API additions

| Method & path | Purpose |
|---|---|
| `GET /api/project` | Project, sources, resources, defaults, identity |
| `GET /api/graph[?goal=&since=]` | Concepts + links (+ delta since an op id) |
| `GET /api/concepts/:id` | A concept, its history (operations), links |
| `POST /api/concepts` | Create (goal, task, decision…) |
| `POST /api/concepts/:id` | Set fields (`base` required) / drop |
| `POST /api/goals` | A goal, and its planner task unless `plan: false` |
| `POST /api/tasks/:id/start` · `/pause` · `/drop` · `/tell` · `/abandon` | Steering (start also continues and resumes) |
| `POST /api/tasks/:id/from-here` | A sibling task that starts from this task's latest checkpoint |
| `POST /api/checks` | A check (`on`: a lesson, task or goal; `title`, `file`, `script`), active at once |
| `POST /api/tasks/:id/checks` | Run the task's checks now in its workspace |
| `POST /api/recipes` | A recipe for a task (`taskId`, `title`, `file`, `script`, `params`, `outputs`, `tolerance`) |
| `POST /api/recipes/:id/verify` | Verify by a clean replay, in the background |
| `POST /api/recipes/:id/replay` | A replay task with other parameters (`params`, `title`) |
| `POST /api/nodes-retry/:id` | Try another way: a task under `:id` from its checkpoint before the first abandoned child |
| `GET /api/outputs/:id` | An output's content: the workspace, else the newest checkpoint holding the cited version |
| `GET /api/activity` · `POST /api/scheduler` | Activity feed; the auto-start toggle |
| `POST /api/questions/:id/answer` | Answer |
| `POST /api/ops/:id/undo` | Inverse batch |
| `GET /api/tasks/:id/export` | Export preview / file |
| `POST /api/seen` | Mark nodes seen (local) |

Phase 1 endpoints stay for the Code view. The security rules are unchanged (§6 of Phase 1).

## 14. CLI additions

```
turtle project create <dir> --source <path>... [--name]
turtle project add-source <path> [--id]
turtle goal "<text>"                       # new goal; with --plan, starts a planner agent on it
turtle graph [--goal <id>] [--all]         # the mind map as an indented text tree
turtle task add "<title>" [--parent] [--after <task>...] [--from <task|checkpoint>] [--no-agent]
turtle task start|pause|resume|drop <task>
turtle tell <task> "<instruction>"
turtle answer <question> "<text>"
turtle check add <lesson|task|goal> --script check_oos.py [--title]   # active at once
turtle check run|list <task> · turtle check activate|retire <check>
turtle recipe add <task> --script compile.sh --param MODEL=A --output 'build/model-${MODEL}.bin' [--tolerance 0.03]
turtle recipe verify <recipe> · turtle recipe replay <recipe> --param MODEL=B · turtle recipe list <task>
turtle share <task|goal> [-o file.html] [--check] [--judge yyyn]   # "export" stays the Phase 0 git export
turtle audit [--task <task>...] [--force]
turtle undo <op>
turtle stats --gate                        # G1–G5 (§15)
```

`turtle run` stays as a shortcut: it creates a task under the current goal (or "Ad-hoc") and starts it.

## 15. Measuring the gate

- **G1 — rewindable.**
  - From the records: checkpoints with a resume point ÷ declared checkpoints.
  - Fork success, from runs of "new task from here". A fork succeeds when the new run (a) restores the files of every source and (b) does not repeat a step that the checkpoint's summary lists as finished, as judged by the audit model from the tool log.
  - An automated check (`pnpm e2e:rewind`, Haiku) forks from three points of a recorded run and reports both.
- **G2 — truthful.**
  - *Evidence ratio*: findings with ≥ 1 evidence link ÷ all findings; `done` tasks with ≥ 1 checkpoint ÷ all `done` tasks.
  - *Audit*: for each finished task, Haiku compares its findings, decisions and status against its tool log and diff. It answers per item: supported, unsupported or contradicted. Agreement = supported ÷ items. Cost is reported (target < 3 % of run cost).
- **G3 — shareable.**
  - The user exports 3 real tasks and judges each against four questions: goal, results with evidence, decisions, open questions.
  - `turtle export --check` runs the optional model proxy and a redaction scan (home paths, env-like `KEY=` values, tokens).
- **G4 — tokens.**
  - Usage per finished task.
  - The share spent on `turtle_*` tool calls and the context assembler's additions.
  - Repeated work: tasks whose tool logs re-run a command already run by a task they depend on.
- **Redirect latency** (recorded, not gated): from `instruction_queued` to `instruction_delivered`, reported as p50/p95, with the duration of the tool that was running at the time.

`turtle stats --gate` prints G1–G5 with pass/fail against §1.

**As built (M8).**

| Part | How |
|---|---|
| **Gate** | `computeGate` (core `project/gate.ts`) reads the project and every source's records. `turtle stats --gate [--json]` prints it; the **Gate** button in the Tasks toolbar shows it (`GET /api/gate`). Exit code 1 when a gated group fails |
| **G1** | Declared checkpoints (agent-declared, not recipe runs) with a session and resume message ÷ all; runs started from a checkpoint (`startFrom`: new task from here, retries, replays) whose first run did not fail. `pnpm e2e:rewind` (real model, Haiku by default) makes a three-step task and forks from each checkpoint, checking that the files are restored and no finished step is written again; `--fake` runs it with a scripted agent |
| **G2** | Findings with an evidence link; done tasks with a checkpoint link; the audit: `turtle audit` (or **Run the audit** in the Gate dialog, when `turtle ui` has an API key) sends each finished task's findings, decisions, status, brief and lessons in force, with its tool log (inputs and results, clipped, newest kept) and checkpoints, to the summarizer model, which answers supported / unsupported / contradicted per item. Audits are stored in `.git/turtle/gate/audits.json` of the project and redone when a task changes. Cost is shown against the run cost |
| **G3** | `turtle share <task|goal>` (or **Share as a file…** in the panel) writes one HTML file (§10): briefs, findings with evidence (text and images ≤ 1 MB inlined, CSV as tables, others by path and sha256), decisions, questions, lessons, checks, recipes; never tool logs or transcripts. Home paths and secret-looking values (API keys, tokens, `*_TOKEN=…`, private keys, `Bearer …`) are redacted, and the result is scanned again (`leaks`). `--check` adds the model proxy (the four questions from the file alone); `--judge yyyn` or the dialog's four checkboxes record your judgment in `.git/turtle/gate/exports.json` |
| **G4** | Tokens per done task (sum of the nodes' usage); the turtle-tool share is estimated from characters of tool inputs, results and agent text (the demo agent, which does little else, scores high); repeated work compares Bash commands with those of the tasks depended on |
| **G5** | Recipe states, replay results (`replay.result`, repairs), and check results that failed at some point (from the operation log) and pass now |

## 16. Testing

| Layer | What |
|---|---|
| core: op log | Hash stability, batching, CAS, replay = cache, rebuild from refs, version vectors, stale-base rejection (agent) vs win (member), undo |
| core: multi-source | Two sources: snapshot both, unchanged source keeps its node, fork restores both, export per source |
| core: scheduler | Ready rules, dependency start, cap, pause/drop, restart recovery |
| runner: tools | FakeAgent gains `task`, `finding`, `decision`, `question`, `brief`, `graph`; runner-claude mock-SDK tests for the new MCP tools; hook-based instruction delivery (PostToolUse and Stop), with a **live check** against the real SDK (`pnpm e2e:tell`, Haiku, ~$0.02) |
| server | Graph API, deltas, steering endpoints, export redaction (no home paths, no transcripts) |
| web | Tree layout, collapse, delta merge, new badges; `pnpm ui:smoke` extended with the phone scenario |
| scenario | The phone scenario (architecture §3.1) with a FakeAgent planner and fake device scripts: goal → 5 tasks → dependency start → question → answer → finding with evidence → "Model B from Environment" → export. It also drives `pnpm demo:ui` |

## 17. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Identity, project create/open, `turtle-project.json`, pointer from code repos | `turtle project create` and `turtle init` both open a project |
| M1 | Operation log + SQLite view + rebuild + undo | Rebuild from refs reproduces the cache byte for byte in tests |
| M2 | Concepts API (core + server + CLI `goal/task/graph`), migration of Phase 0–1 branches | An existing Phase 1 repo opens as a graph |
| M3 | Multi-source workspaces and checkpoints (`RunSession` generalization) | Two-source scenario test passes; single-source behavior unchanged |
| M4 | Agent tools + context assembler + briefs | FakeAgent scenario builds the phone graph |
| M5 | Steering: tell (live-verified as a streaming user message, not hooks), pause/resume/drop, edits → instructions | **Done**, with the first task-graph UI, the in-process scheduler and an offline demo agent (`pnpm demo:ui`) |
| M6 | Scheduler + caps + notifications (dependency start, "waiting for …" and auto-start already built with M5) | Budget cap, batched Activity, a daemon-free restart story |
| M7 | Mind map UI: tidy tree, dependency arrows, conversation/outputs/code tabs, new task from here, dependency picker | **Done**: `pnpm ui:smoke` drives the trading and phone scenarios end to end |
| M7.5 | Checks: lessons hardened into scripts, enforced at checkpoints (architecture §3.7) | **Done**: the trading demo's check fails, the agent fixes it, B passes; `pnpm ui:smoke` covers it |
| M7.6 | Recipes verified by a clean replay; replay with parameters without a model; agent repair of a failed replay; scripts in the agent's sandbox; `turtle_check` helpers | **Done**: the phone demo's MODEL=B replay fails, is repaired and verifies; `pnpm ui:smoke` covers it |
| M8 | Export (`turtle share`, `--check`, judgments), `stats --gate` with G5, the audit, `e2e:rewind`, Gate dialog, docs | **Done**: gate report on the demo (`pnpm ui:smoke` shares, judges and opens the gate); `e2e:rewind --fake` passes; tutorial Part E |
| M9 | User acceptance on macOS: the gate (G1–G4) on a real task of the user's | Gate passed or findings recorded |

## 18. Known limitations and open questions

- **Scheduling needs `turtle ui`** (or explicit `turtle task start`); there is no daemon until Phase 3.
- **No resource locks yet.** Two tasks can still use one phone at once. The UI warns when two running tasks list the same resource.
- **Combining upstream code.** A task that depends on tasks in *different* branches of the same source starts from one of them; it gets the others' findings and outputs, not their code. Code merging is Phase 3.
- **Hook delivery (resolved in M5).** `additionalContext` from PostToolUse does reach the model, but the model treats it as possible prompt injection and ignores instructions in it. Instructions now go in as streaming user messages (§11). An instruction that arrives exactly as the agent ends its turn relies on the runner's 3 s close delay; that path is tested with the FakeAgent, not yet live.
- **Resources that need confirmation** (`confirm: always`, architecture D29) are recorded in Phase 2 but enforced in Phase 3, together with locks.
- **Planner quality.** Whether agents split goals into good tasks is part of G2/G4. If not, the planner prompt becomes a configurable template.
- **Migration** maps Phase 0–1 runs to tasks without findings; their briefs are generated from summaries.
