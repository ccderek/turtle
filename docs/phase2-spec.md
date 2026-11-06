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
  kind: "goal" | "task" | "finding" | "decision" | "question" | "output";
  parentId: string | null;
  title: string;                   // one line
  body: string;                    // markdown
  // task
  status?: "todo" | "running" | "paused" | "need_decision" | "blocked" | "done" | "failed" | "dropped";
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
- **A checkpoint** is a row `checkpoints(id, task_id, at)` plus one Phase 0 node per touched source (`checkpoint_parts(checkpoint_id, source_id, node_id)`). Sources whose tree did not change still get a part pointing at their previous node, so a checkpoint always names the full state.
- **`RunSession` generalization.** It gains `sources: { id, store, db?, branch, workspace }[]`. Each tool boundary snapshots every source (unchanged trees are skipped cheaply by `write-tree` comparison). Rules and summaries operate on the combined diff.

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
| `turtle_graph` | `{ scope?: "task" \| "goal" }` | Compact text view of the relevant graph: own task, siblings' status, dependency findings, decisions. Default `task` |

System prompt additions (draft):

> You are working on one task in a shared task graph that a human watches. Record what you learn with turtle_finding (attach evidence: a file you wrote, a command's output saved to a file, a checkpoint). Ask with turtle_question only when a human must decide. Split work with turtle_task only when parts can run independently or need a different start. Keep the brief current with turtle_brief at each checkpoint: status first, then conclusions with evidence, then open questions. Instructions from the human may arrive between tool calls marked "[from derek]": follow them.

Guards:
- **Caps on what an agent may create.**
  - At most 8 tasks per agent turn.
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

## 10. Briefs and export

- **What a brief is.** The agent keeps it current with `turtle_brief`, at least at every semantic checkpoint. The system prompt asks; the orchestrator reminds in the checkpoint reply if the brief is older than the last two checkpoints.
- **Fallback.** If a task ends with no brief, a brief is assembled from its findings, decisions and last checkpoint summary (no model call).
- **Export.** "Export" on a task or goal writes one self-contained HTML file: the subtree's briefs, findings with evidence (artifacts inlined when under 1 MB, outputs by path and sha256), decisions and status. It never includes transcripts, environment variables or the member's home path (`/Users/derek/...` becomes `~/...`). A preview shows exactly what is included before writing.

## 11. Steering: redirect, edit, pause, drop

| Human action | Delivery to the running agent |
|---|---|
| **Tell the agent…** (free text) | Queued as an instruction. At the next PostToolUse boundary, the hook's reply carries it as `hookSpecificOutput.additionalContext` ("[from derek] …"). If the agent ends its turn first, the **Stop** hook carries it in `additionalContext` and the conversation continues. **VERIFY** both deliveries with the real SDK; the types exist in 0.3.316 |
| Edit the task's title/body/dependencies | An instruction is generated: "derek changed this task: <diff>" |
| Pause | Interrupt (Phase 0); status `paused`; resume = continue the branch with "resumed by derek" |
| Drop | Interrupt; status `dropped`; work is kept as a `killed` checkpoint |
| Answer a question | As in Phase 1 (continue), plus the decision concept |

Every delivery is an event (`instruction_queued`, `instruction_delivered` with the tool-use id), which gives G3.

**Fallback.** If the hook path fails, the instruction is delivered by interrupt + continue with the instruction as the prompt. This is slower and loses the in-flight tool call.

## 12. UI

The mind map becomes the home screen; the Phase 1 tree becomes the **Code** tab of a task (filtered to its checkpoints) and a global Code view.

| Area | Content |
|---|---|
| Top bar | Project, goal switcher, running / needs-you / cost, parallel cap, **Code** view toggle |
| Left | *Needs you* (questions, blocked, failed, budget only), *Activity* (batched new tasks, findings, decisions), running agents, sources |
| Center | Mind map (as in the prototype): goal → tasks → children (findings, decisions, questions, outputs, subtasks); collapse per node; dependency arrows on hover; `new` badges; status colors; "waiting for …" lines |
| Right (task) | Brief; facts (agent, status, depends, sources, start point); question box; **Tell the agent…**; findings with evidence (claimed vs evidenced); decisions; tabs: Conversation (live), Code (checkpoints + diffs), Outputs; actions: Pause, Drop, Start now, New task from here, Export |
| Inline edits | Title and body editable in place; "＋" on a card adds a child task; drag to reorder siblings; a dependency picker |

Layout: a horizontal tidy tree (Reingold–Tilford style). It is computed client-side, sized for ≤ 300 visible cards, and subtrees collapse beyond that. Live updates use the Phase 1 SSE `change` channel plus a new `GET /api/graph?since=<opId>` delta, so the graph no longer refetches whole.

## 13. HTTP API additions

| Method & path | Purpose |
|---|---|
| `GET /api/project` | Project, sources, resources, defaults, identity |
| `GET /api/graph[?goal=&since=]` | Concepts + links (+ delta since an op id) |
| `GET /api/concepts/:id` | A concept, its history (operations), links |
| `POST /api/concepts` | Create (goal, task, decision…) |
| `POST /api/concepts/:id` | Set fields (`base` required) / drop |
| `POST /api/tasks/:id/start` · `/pause` · `/resume` · `/tell` | Steering |
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
turtle export <task|goal> [-o file.html]
turtle undo <op>
turtle stats --gate                        # G1–G4 (§15)
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

`turtle stats --gate` prints G1–G4 with pass/fail against §1.

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
| M5 | Steering: tell via hooks (live-verified), pause/resume/drop, edits → instructions | `pnpm e2e:tell` passes; G3 events recorded |
| M6 | Scheduler + caps + notifications | Dependency start and "waiting for …" in the scenario |
| M7 | Mind map UI (home), task panel, Code tab, inline edits | `pnpm ui:smoke` drives the phone scenario end to end |
| M8 | Export (+ `--check`), `stats --gate`, `e2e:rewind`, docs + tutorial update | Gate report on the demo; tutorial Part D (task graph) |
| M9 | User acceptance on macOS: the gate (G1–G4) on a real task of the user's | Gate passed or findings recorded |

## 18. Known limitations and open questions

- **Scheduling needs `turtle ui`** (or explicit `turtle task start`); there is no daemon until Phase 3.
- **No resource locks yet.** Two tasks can still use one phone at once. The UI warns when two running tasks list the same resource.
- **Combining upstream code.** A task that depends on tasks in *different* branches of the same source starts from one of them; it gets the others' findings and outputs, not their code. Code merging is Phase 3.
- **Hook delivery.** **VERIFY** that `additionalContext` from PostToolUse reaches the model *before* its next decision, and how a Stop-hook continuation is counted in `num_turns` and cost.
- **Planner quality.** Whether agents split goals into good tasks is part of G2/G4. If not, the planner prompt becomes a configurable template.
- **Migration** maps Phase 0–1 runs to tasks without findings; their briefs are generated from summaries.
