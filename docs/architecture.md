# turtle — Architecture Design (Draft v0.4)

> Status: Phases 0–1 implemented ([phase0-spec.md](./phase0-spec.md), [phase1-spec.md](./phase1-spec.md)).
> - v0.2 added the **task graph** (§3.1). turtle becomes an agent-native project management tool: humans and agents share a mind map of tasks, and the code tree is its evidence layer.
> - v0.3 makes turtle a general, multi-user version system for intent, not bound to any code repository:
>   - a **turtle project** sits above repositories (§3.2);
>   - it syncs local-first like git (§3.3);
>   - it has roles and runners (§3.4);
>   - it is built on a small core (§3.5).
> - v0.4 adds **hardening** (§3.7, D31): what worked and what must hold become code that turtle runs (checks, then recipes), so a replay does not depend on the agent choosing the same path.
>
> Items marked `TODO` are open questions.

---

## 1. Background & Observations

1. AI produces artifacts far faster than humans can absorb them, so humans lose the ability to version-control the work.
2. AI spawns multiple agents doing different things at once. Some output is experimental / throwaway, some is not, and every run produces different output (non-determinism).
3. What the AI does is not always what the user wants, and the user's requirements keep shifting. The same code goes through many pivots and becomes hard to track.
4. The human–AI interface is linear (chat), but AI codegen unfolds as a tree. Managing several branches today means opening several conversations and scrolling back to find the right fork point.
5. Humans cannot correct a wrong AI branch in real time; they can only intervene through conversation, which is not version-controlled.

## 2. Goals

Build a new human–AI interface that lets a human:

- See and control AI progress **in real time** (the commit tree plus the Thinking/Working currently in flight).
- Run multiple AIs **in parallel** while controlling every branch (fork / merge / kill / redirect / snapshot).
- On any branch, manually ask the AI to **explore more alternatives** and compare them.
- **Reduce overall token usage** through the right implementation choices.
- (v0.2) Plan and track the work as a **shared task graph**: humans and agents both add tasks, and every task shows its status, owner and evidence at a glance (§3.1).

### 2.1 Does the design still answer the motivation? (v0.3 review)

| Observation (§1) | Answered by | Status |
|---|---|---|
| 1. Output outpaces human attention | Mind map as main screen, attention queue, claim vs evidence, batched notifications | Designed; **not yet validated** (Phase 1 manual test pending) |
| 2. Many agents, throwaway work, non-determinism | Tasks, branches, fork, parallel scheduling | Scheduling in Phase 3 |
| 3. AI misreads intent; requirements keep shifting | Questions, decision nodes, human edits as instructions | Pivots are kept as decisions, unlike Phases 0–1 |
| 4. Linear interface, tree-shaped work | Mind map + code tree | Fits |
| 5. No real-time correction; interventions unversioned | Stop, redirect, every edit a versioned event | **Redirect must ship in Phase 2.** It was deferred in each re-plan, yet it is the original pain |

Course corrections adopted in v0.3:

1. **Validate before infrastructure.** Multi-user sync, permissions and a server are heavy, and they do not differentiate turtle. The core hypothesis comes first: the task graph is a **faithful, rewindable and shareable record** of AI work, cheap enough to keep. The human reads it when they want and is notified rather than asked. So Phase 4 (multi-user) starts only after Phase 2 passes criteria measured from the records (§15).
2. **Keep the core small (D27).** git is universal because its core is tiny (objects + refs). turtle's core is concepts, operations and evidence links. Assignment, notifications, scheduling and permissions sit on top. Without that, turtle becomes another ever-growing tracker.
3. **Do not drop two original goals.**
   - Exploring alternatives (D2) moves into Phase 3: with a scheduler, "explore N approaches" is just N sibling tasks.
   - Token use becomes a metric every phase reports. The graph should reduce it, through shared findings (no repeated exploration), reuse and early kills.
4. **The graph's truthfulness is measured, not assumed.** Phase 2 measures how well the graph agrees with what agents actually did.

## 3. Core Idea: Two Trees

| Tree | Content | Today |
|---|---|---|
| Code-state DAG | What the code looks like | Solved by git |
| Process / intent tree | Who, under which instruction, thought what, spent how many tokens, and why it branched | **Nobody handles this** |

**turtle's core value is linking the two trees**: every code snapshot can answer "which intent did this come from, and what was the context at the time?"

Phases 0–1 built the code tree and kept the intent only as one summary per checkpoint. Using it showed the gap: a human still has to read summaries and diffs and assemble "what is the AI doing, and how far along is it?" in their head. v0.2 makes the intent tree a first-class object: the task graph.

### 3.1 The task graph (v0.2)

**Decision (D15): turtle is an agent-native project management tool.** Its primary object is a **task graph**, drawn as a mind map, that humans and agents both edit. Each task can be assigned to an agent, and the work it does lands on a code branch. The checkpoints, diffs and artifacts on that branch are the task's evidence.

```
Layer           Holds                                                  Stored in              Rewindable
──────────────  ─────────────────────────────────────────────────────  ─────────────────────  ──────────────────────
Concept         goal, tasks, findings, decisions, questions, outputs   SQLite + git ref       yes (versioned, op log)
Code            files at every checkpoint                              git (refs/turtle/*)    yes
Environment     how to rebuild the machine: Dockerfiles, setup scripts part of the code layer  yes, as code (D4)
External        devices, databases, cloud services                     resources + ledger     no: side effects marked
```

Concept kinds are deliberately few:

| Kind | What it is | Who usually adds it |
|---|---|---|
| **goal** | What the human wants, in their words; the root of a graph | Human |
| **task** | A unit of work. It has a status, an assignee (agent or human), dependencies, the resources it needs, and where it starts from | Both: the agent splits a goal; the human adds, edits, reorders or drops tasks |
| **finding** | A fact learned while working ("3.2 W, 45 ms per inference") | Agent, with evidence |
| **decision** | A choice made, and by whom ("3 runs × 5 min, cooldown 2 min") | Human answering a question, or agent |
| **question** | Something only the human can decide; it blocks the task it belongs to | Agent |
| **output** | A produced file: small ones are artifacts in git, large ones (model binaries, traces) live outside git and are recorded by path + sha256 | Agent |
| **lesson** (v0.3) | A take-away from work that is kept but should not be repeated ("only use data known before the close of t-1"). It hangs on the node it applies to and holds for that whole subtree | turtle drafts it when an approach is abandoned; the human edits or confirms it; agents may propose one |

Rules:

- **Claim vs evidence.** Every finding and every `done` carries evidence links (a checkpoint, an artifact, an output, a test result). Without them it is shown as *claimed*, never as verified.
- **Both sides edit; every edit is an event.** Human edits are instructions to the agents. Examples: drop a task, change a dependency, edit a decision, add "Model C reusing the environment". The agent working on an affected task is told at its next tool boundary (redirect, §8). Agent edits go through MCP tools, which are cheap structured calls like `turtle_checkpoint`:
  - `turtle_task` creates or updates a task;
  - `turtle_finding`, `turtle_decision` and `turtle_question` record the other concept kinds.
- **The graph is the main screen (D18).** The code tree is a drill-down from a task.
- **Reuse is explicit.** A task can start *from* another task's checkpoint ("Model B reuses the environment task"). This is a fork (§8): the new task inherits the files and the conversation up to that point.
- **Abandon, learn, rewind (D28).** When an approach turns out wrong:
  1. Its task is **abandoned**, not deleted. Its subtasks, code and data stay in the record.
  2. turtle drafts a **lesson** from the abandoned task's findings, tool log and diff. The human edits it.
  3. The lesson is attached to the node the human rewinds to.
  4. The next attempt is a new sibling task that **starts from a checkpoint taken before the failed approach**. Its files and conversation go back to that point, so it carries none of the failed transcript, only the lessons.
  5. Every task started anywhere under that node receives its lessons in its prompt. An audit checks its work against them, and a violation goes to *Needs you*.

Worked example (from the first user scenario): measuring a model's power and performance on a phone.

```
Goal: measure power/performance of model A (then B)
├── Environment: connect phone, lock clocks      agent α   done      out: env/phone-setup.sh
├── Compile model A                              agent β   done      out: model_a.bin (outside git)
├── Test plan                                    agent α   done      decision: 3 runs × 5 min (you)
├── Measure model A  ← needs all three ↑        agent δ   running   holds Pixel-1
│   ├── finding: 3.2 W · 45 ms/inference          evidence: results/model-a.csv
│   └── record trace (perfetto)                            running
└── Model B  (starts from "Environment")        agent γ   waiting   queued for Pixel-1
    ├── compile with another toolchain                     done
    └── decision: per-layer CSV output
```

### 3.2 A turtle project sits above repositories (v0.3)

**Decision (D23):** turtle versions intent, not code, so it is not bound to a code repository. A **turtle project** is its own repository. It holds the task graph, its operation log, members and settings. Code repositories, resources and an output store are **attached** to it.

```
turtle project "perf-lab"            (a git repository of its own: graph + op log)
├── task graph and operation log
├── members, roles, runners
└── attached sources
    ├── git repo A  (measurement scripts)   ← tasks open branches here
    ├── git repo B  (models, compile config)
    ├── resources: Pixel-1, Pixel-2
    └── output store (traces, binaries; outside git)
```

- **A task touches zero, one or several repositories.** A research task may only produce outputs.
- **A checkpoint becomes a set of per-repository snapshots** taken together: one commit in A and one in B form one checkpoint. A fork restores all of them.
- **Export is per repository:** a branch or PR in each repository the task changed.
- **The Phase 0–1 code becomes the per-repository code-layer engine** (snapshot, materialize, fork, resume), driven by the project. `.git/turtle/` inside a code repository becomes that repository's cache.

### 3.3 Many people: local-first, synced like git (v0.3)

**Decision (D24):** every member (and every machine) has a full replica of the project. Replicas sync through a remote, like git, so work is offline-capable and fast locally.

- **The operation log is stored as git objects.** Each replica appends to its own ref, `refs/turtle/ops/<member>/<replica>`, so a push never conflicts on a ref.
- **The graph is the merge of all logs**, in the manner of a CRDT and of jj's operation log.
- **Two edits to the same field are surfaced as a conflict for a human.** They are never silently overwritten.
- **Execution facts win over edits.** Status reported by the running agent overrides concurrent field edits.
- **First sync target: any git remote.** A plain repository on GitHub gives multi-user access with the remote's permissions.
- **Later: a turtle server** (Phase 5) for live share links, per-node permissions, comments from people without turtle, and shared runners.

### 3.4 Roles, sharing, agents and runners (v0.3)

| Role | Can |
|---|---|
| Owner | Everything, including members and roles |
| Editor | Add and edit tasks, start agents, instruct agents directly |
| Commenter | Comment and make requests; a request becomes an instruction once the task's owner accepts it |
| Viewer | Read |

- **Roles apply to the whole project or to a subtree.** Sharing a node means granting a role on its subtree (D25).
- **The node is the unit of sharing (D22).**
  - Each node has a **brief** that the agent keeps current: goal, status and conclusion first, then findings and decisions with evidence links, then open questions and next steps.
  - The brief replaces separately written status documents: people read the live node instead of a copy.
  - Transcripts, environment variables and local paths are excluded from what is shared by default.
  - Until there is a server, a node can be exported as a self-contained page (a static snapshot).
- **An agent always acts on behalf of one member (D26).** It uses that member's runner and model credentials, and pays with that member's account. It is recorded as "agent α for derek".
  - Only editors start agents.
  - Instructions from others reach the agent through sync.
  - A **runner** is a machine that executes agents: a member's laptop, or a shared lab machine with the phones attached. The lab machine accepts tasks from members allowed to use it.
- **Irreversible resources need a human (D29).** A resource can be marked `confirm: always`, for example a live trading account, production, a payment API. An agent that is about to use it stops and asks, and the question goes to *Needs you*. A human confirms each first use, plus any change of limits. This applies the §10 principle that irreversible actions require human confirmation.
- **Agent-created tasks start immediately (D21).** Humans are notified instead of asked:
  - new nodes are flagged until seen;
  - notifications are batched in an *Activity* feed ("α added 3 subtasks"); *Needs you* holds only what blocks on a human (questions, blocked or failed tasks, budget limits);
  - every new task offers Pause and Drop;
  - budget, parallelism and depth caps queue the excess, and the UI says why it is queued.

### 3.5 Memory is the graph (v0.3)

**Decision (D30):** turtle has no separate memory store. The task graph is the memory.
- Lessons, findings and decisions are concepts with provenance links (where they came from) and a scope (the subtree they apply to), so they already form a DAG.
- They live in the operation log like every other edit: authored, versioned, undoable, synced.

| Phase | Retrieval |
|---|---|
| 2 | **By scope**: a task gets the lessons on all its ancestors. Deterministic, cheap, hard to get wrong |
| 3 | **Project search**: an agent asks for related lessons and findings anywhere in the project (`turtle_lessons(query)`). The search index (text or embeddings) is a rebuildable cache, never the source of truth |
| 5 | **Across projects and people**: shared lesson libraries ("always validate out of sample"), through the turtle server and roles |

A lesson carries:
- its evidence;
- who confirmed it;
- its status: `proposed` (by an agent), `confirmed` (by a human) or `superseded` (by a later finding, which links to it).

Superseded lessons are no longer injected.

A lesson in a prompt is only advice. §3.7 turns the lessons that matter into executable checks.

### 3.6 The core object model (v0.3)

**Decision (D27):** like git's objects and refs, turtle's core is small, and everything else is built on it.

| Core object | Role |
|---|---|
| **Concept** | A goal, task, finding, decision, question or output, with its fields (§5) |
| **Operation** | One immutable change to concepts, signed by an actor (a member, or an agent for a member), with causal parents; the log is append-only |
| **Link** | Evidence and provenance: concept → checkpoint (per-repo commits), artifact, output, other concept |
| **Checkpoint** | A set of per-repository commits taken together (the code layer, §4) |

On top, not in the core:
- scheduling, resources and runners;
- notifications, the UI and briefs;
- permissions enforcement;
- agent adapters.

### 3.7 Hardening: intent checkpoints become verifiable code (v0.4)

**The problem.** Rewinding is exact: a checkpoint restores the files and the conversation. Replaying is not. After a rewind, or when the same step runs again for a new input ("Model B"), the agent can take a different path. Lessons are text in a prompt, so an agent can still repeat the mistake, and nothing notices. Lessons and rewinds lose their value if what happens after them is left to chance.

**Decision (D31):** an intent that worked, or a lesson that must hold, is **hardened** into code that turtle runs, not text that the agent reads. There are four levels, from soft to hard:

| Level | What | Who runs it | Example |
|---|---|---|---|
| **L0 Note** | A lesson as text (§3.5) | The agent reads it | "Only use data known before the close of t-1" |
| **L1 Check** | An executable acceptance condition on the result. It does not prescribe how the work is done | turtle, at every semantic checkpoint in its scope | `check_no_lookahead.py`: every feature's timestamp is before the t-1 close |
| **L2 Recipe** | The steps that worked, as a script with parameters and pinned inputs. Replaying the step runs the script; an agent is called only where the script fails | turtle | `connect_phone.sh`, `compile.sh --model A`, `measure.py --rate 10k` |
| **L3 Policy** | A rule that stops an action before it happens | turtle's hooks | Never touch the live trading account (D29 `confirm: always`) |

**Checks (L1).**
- **A concept of kind `check`.** It has a scope (its parent: the check applies to every task under it, like a lesson) and a script with a file name (`check_oos.py`).
  - The script lives **in the graph, not in the agent's workspace**. turtle writes it to a temporary directory and runs it with the task's workspace as the working directory. The agent cannot edit or delete it, and a check cannot be weakened by the work it judges.
  - It runs **in the agent's sandbox**: on the host for `sandbox: none`, in the runner image with the workspace mounted at `/workspace` for `docker` (the image must have the interpreter, e.g. python3).
  - An `enforces` link points to the lesson it hardens.
- **The contract is language-neutral.** Exit code 0 passes and anything else fails; the output is the explanation shown to the agent and the human. The interpreter follows the extension (`.py` → python3, `.sh` → bash, `.js`/`.mjs` → node). Python is the default for data and measurement checks, and every script can `from turtle_check import *`: `read_csv`, `column`, `mean`, `within(actual, expected, rel=0.03)`, `expect`, `expect_within`, `param`, `done()`.
- **States.** A member's check is `active` at once. An agent may only **propose** one (`proposed`): it does not run until a member activates it, because a check is an acceptance condition that a person sets, not the agent being judged. `retired` checks stop running.
- **Enforcement.**
  - Every active check in scope runs at each semantic checkpoint of a task.
  - A failure is written into the checkpoint's reply, so the agent can fix the work in the same run.
  - A task whose last checkpoint fails a check cannot end `done`: it ends `blocked` and goes to *Needs you*.
  - Results are kept on the task (per check: pass or fail, checkpoint, output) and shown on the map.
- **Limits.**
  - A check only catches what it tests, so the truthfulness audit (G2) stays.
  - Measurements of the outside world (a phone's power, market data) need tolerances, not equality.
  - Checks run with the member's permissions, with a timeout, and without the agent's credentials in the environment.

**Recipes (L2).**
- **A concept of kind `recipe`** under a task: a script (stored in the graph, like a check), **parameters** with defaults (environment variables, e.g. `MODEL=A`), the **outputs** it regenerates (paths, which may use `${MODEL}`), and a **tolerance** for numbers in CSV/TSV outputs. An agent records one with `turtle_recipe`; a member can write one too.
- **Verification by a clean replay.** turtle materializes the task's latest checkpoint in a fresh directory, deletes the outputs, runs the recipe with its defaults in the agent's sandbox, compares each regenerated output with the checkpoint's version (equal bytes, or CSV numbers within the tolerance), and runs the checks in scope. Only then is the recipe `verified` and the task **hardened**. In `turtle ui` this happens on its own when the run that recorded the recipe ends.
- **Replay with parameters.** "Replay with…" on a verified recipe creates a task that starts from the verified checkpoint. Its first run is the recipe itself, run by turtle with no model: if it works, the task is done at no token cost. If it fails, the task is blocked with the output, and an agent takes over (once, automatically with auto-start) with the task prompt, the recipe and the failure, and is told to fix only what fails and record the updated recipe, which is verified in turn. For "Model B", only the compile step needs an agent; the rest is the same as for A, so the measurements compare.
- **Limits.** Single-source projects only for now (a multi-source checkpoint is a set of commits). A recipe proves that the outputs follow from the checkpoint's files, not that those files are right; checks and review still matter. A recipe that calls hardware (a phone over USB) needs `sandbox: none`.
- **When to harden.** Not every step is worth it; exploration stays free. Agents are asked to record a recipe when a step could be redone (another model, new data).

**Path replay: redo a task's steps somewhere else.** A task's record is already the harness for redoing it: its checkpoints are the steps (with their intent, the summary), its recipe reruns the results, its checks say what must hold. **Replay…** on a task redoes its steps up to a checkpoint onto a new base, with other parameters:
- **Bases:** your repository as it is now (the code changed since), the same start as before (only parameters change), or another task's latest checkpoint.
- **Code is applied, results are rerun, never copied.** Each step's code change (its diff since the previous checkpoint, with the task's output files left out) is applied with `git apply`. The results are regenerated by the task's verified recipe with the new parameters. Copying the old result files would present old numbers as new ones.
- **No model unless a step fails.** The first run is a scripted runner. A change that no longer applies, a recipe that fails, or results without a recipe stop it, and an agent takes over with the task prompt and a "## Replay" section: what is already done, what is left (each remaining step's intent, files and original change), and what to do next. It is asked to record a recipe, so the next replay needs no agent.
- **Then.** An optional instruction for an agent to continue with after the replay ("compare with the original").
- **Chains.** A task can be replayed together with the tasks upstream of it (its dependencies, and the task it started from), in order: each replay starts when the one before is done, and a task that started from an upstream task's checkpoint starts from that task's replay, so it reruns on the new results (data → signal → backtest with another date range). Upstream tasks left out are kept as they were.
- **The flywheel:** steps that were hardened replay for free; steps that were not are redone by an agent once, which then hardens them.

**What this changes.** Checkpoints keep their exact rewind. Hardened checkpoints add a reproducible replay. Lessons become guarantees where they can be checked and stay advice where they cannot. Replays that reuse recipes spend tokens only on what is new (G4).

### Glossary

- **Node**: a checkpoint — one commit plus intent/process metadata.
- **Micro snapshot**: an automatic snapshot after every tool call; hidden in the UI by default.
- **Semantic checkpoint**: a meaningful milestone (declared by the AI or triggered by a rule); shown in the UI by default.
- **Exploration Group**: the set of sibling branches produced by one `explore` operation.
- **Snapshot (human-tagged)**: a node a human marks to keep and reuse.
- **Concept**: an item in the task graph (goal, task, finding, decision, question, output).
- **Task**: a concept that is a unit of work, assignable to an agent; its work runs on a code branch.
- **Resource**: something outside the code that tasks share and that cannot be rewound (a phone, a test database); it has a lock and a queue.
- **turtle project**: the repository of intent: task graph, operation log, members; code repositories are attached to it.
- **Replica**: one member's copy of a project on one machine; replicas sync through a remote.
- **Runner**: a machine that executes agents on behalf of members.
- **Brief**: a node's living, shareable summary, kept current by the agent.

---

## 4. VCS Foundation: Why git

### 4.1 How git works (relevant parts)

- **Objects**: blob (file content), tree (directory), commit (tree + parents + metadata). Every object is named by its content hash, so **identical content is stored once** — frequent snapshots are cheap.
- **Refs**: movable pointers to commits; history is a DAG.
- **Worktrees**: multiple checkouts of one repo sharing a single object store — a natural fit for isolating many agents.
- **Merge**: three-way merge from the merge base; understands textual conflicts only, not semantic ones.
- **Snapshotting without disturbing the user**:
  `GIT_INDEX_FILE=<tmp> git add -A && git write-tree && git commit-tree <tree> -p <parent>`, then write the result under `refs/turtle/...`.

### 4.2 Semantics worth borrowing from jj (Jujutsu)

| jj concept | Meaning for turtle |
|---|---|
| The working copy is itself a commit, auto-snapshotted | Every agent step is saved automatically |
| change-id separate from commit-id | A node keeps its identity after a human rewrites it |
| Operation log; any operation can be undone | turtle's event log + "rewind the whole system" |
| Conflicts are first-class and can be stored | Parallel branches never get stuck on conflicts |
| Editing an ancestor auto-rebases descendants | A human fix in the middle of a branch flows downstream |

### 4.3 Candidates

| System | Assessment |
|---|---|
| Piper (Google) | Not available externally. Its CitC idea — every save is a snapshot, workspaces live in the cloud — is worth learning from |
| jj | Closest conceptual fit; library API not yet stable, so don't hard-depend on it |
| Sapling (Meta) | Stacked commits and its interactive UI (ISL) are good references; small ecosystem |
| Pijul | Most elegant patch theory; too immature, barely known to AI models and tooling |
| **git** | ✅ Largest ecosystem, every model knows it, output becomes a normal PR |

### 4.4 Decision

**git object store as the storage format + jj semantics as the design blueprint.**

The five capabilities turtle needs:

1. Cheap snapshots → git ✅
2. Many parallel workspaces → git worktree ✅
3. Stable node identity → turtle metadata layer
4. Operation log / undo → turtle metadata layer
5. Deferred conflict resolution → turtle metadata layer

Items 3–5 must be built regardless of VCS, so switching to jj gains little and loses the ecosystem.

**Rule: only the orchestrator writes git refs.** Agents only modify files. This avoids lock contention and inconsistent state when many agents run concurrently.

---

## 5. Data Model

```ts
type NodeId = string;          // Stable ID (like jj change-id); survives content rewrites

interface Node {
  id: NodeId;
  parents: NodeId[];           // usually 1; multiple for merge nodes
  kind: "micro" | "semantic" | "human_edit" | "merge" | "root";
  commit: string;              // git commit sha (changes when content is rewritten)
  tree: string;                // git tree sha (the code snapshot)

  intent: string;              // what this segment is meant to do (human instruction or AI plan)
  summary: string;             // human-readable summary (= commit message)
  summarySource: "agent_declared" | "rule_auto";  // rendered differently in the UI
  transcriptRef: TranscriptRef; // full conversation up to this point (needed for fork / prompt cache)
  artifacts: ArtifactRef[];    // test results, screenshots, logs…
  verified: { tests?: "pass" | "fail" | "none"; diffStat: DiffStat };

  agentId: string | null;      // null for human_edit
  status: "running" | "done" | "killed" | "failed" | "blocked" | "need_decision";
  tokens: { input: number; cachedInput: number; output: number };
  costUsd: number;

  tags: ("snapshot" | "throwaway" | "experiment")[];
  explorationGroupId?: string;
  createdAt: string;
}

// v0.2 — the task graph (§3.1)
type ConceptKind = "goal" | "task" | "finding" | "decision" | "question" | "output";

interface Concept {
  id: string;
  kind: ConceptKind;
  title: string;
  body: string;
  parentId: string | null;     // mind-map hierarchy: goal → task → subtask / finding / …
  version: number;             // every edit is an event and bumps the version
  author: { type: "agent" | "human"; id: string };
  evidence: { nodeId?: NodeId; artifactId?: string; outputId?: string }[];
  // tasks only
  status?: "todo" | "ready" | "running" | "waiting" | "need_decision" | "blocked" | "done" | "dropped";
  assignee?: { type: "agent" | "human"; id: string } | null;
  dependsOn?: string[];        // task ids; a task is ready when all are done
  resources?: string[];        // resource ids it must hold while running
  startFrom?: { taskId: string; nodeId: NodeId } | null;  // reuse: fork from that checkpoint
  branchId?: string | null;    // the code branch where its work lands
}

interface Resource {           // shared, not rewindable (§10)
  id: string;
  name: string;                // "Pixel-1"
  kind: "device" | "service" | "other";
  capacity: number;            // usually 1
  holders: string[];           // task ids
  queue: string[];             // task ids waiting, in order
}

interface Output {             // large produced files, kept outside git
  id: string;
  taskId: string;
  path: string;                // e.g. ~/perf-results/model-a/trace.perfetto
  sha256: string;
  size: number;
}

// v0.3 — projects, members, sync
interface Project {
  id: string;
  name: string;                // "perf-lab"
  sources: { id: string; kind: "git"; url: string; defaultBranch: string }[];
  resources: Resource[];
  outputStore: { kind: "local" | "object-store"; location: string };
}

interface Member { id: string; name: string; roles: { scope: "project" | string /* subtree root concept id */; role: "owner" | "editor" | "commenter" | "viewer" }[] }

interface Runner { id: string; owner: string; name: string; allowedMembers: string[]; resources: string[] /* attached devices */ }

interface Operation {          // the core log entry; replaces Event for concept changes
  id: string;                  // content hash
  replica: string;             // `${memberId}/${machineId}`
  actor: { type: "member"; id: string } | { type: "agent"; id: string; onBehalfOf: string };
  parents: string[];           // causal: the last operations this replica had seen
  at: string;
  change: { concept: string; set?: Record<string, unknown>; create?: Partial<Concept>; drop?: true };
}

interface Checkpoint {         // code layer: one commit per touched repository
  id: NodeId;
  commits: { sourceId: string; commit: string; tree: string }[];
}

interface Event {              // like jj's operation log; append-only
  id: string;
  at: string;
  actor: { type: "agent" | "human" | "system"; id: string };
  type:
    | "tool_call" | "checkpoint" | "fork" | "explore" | "kill"
    | "redirect" | "human_edit" | "merge" | "tag" | "rebase" | "gc"
    | "concept_create" | "concept_update" | "task_assign" | "resource_acquire" | "resource_release";
  payload: unknown;
}
```

---

## 6. System Architecture

```
┌──────────────────────── Web UI ─────────────────────────┐
│ Attention queue │ Tree view │ Node detail │ Compare │ Live │
│ Actions: fork / explore / kill / redirect / merge / tag  │
└───────────────▲─────────────────────────┬───────────────┘
                │ SSE (events)             │ HTTP (commands)
┌───────────────┴─────────────────────────▼───────────────┐
│ Orchestrator (TypeScript daemon, local)                  │
│  • Agent lifecycle: spawn / interrupt / kill             │
│  • Checkpoint engine: hook → snapshot → summary → Node   │
│  • Context assembler: what a forked child agent receives │
│  • Explore flow: Plan → human selects → Execute          │
│  • Budget control: tokens / parallelism / tree depth     │
│  • Sole writer of git refs                               │
└───────┬───────────────────────────────┬─────────────────┘
        │ Adapter interface              │
┌───────▼──────────────────┐   ┌────────▼─────────────────┐
│ Agent Runtime             │   │ Storage                  │
│ 1 container + 1 workspace │   │ git object store         │
│   dir per agent           │   │   refs/turtle/*          │
│ Claude Agent SDK (L2)     │   │ SQLite: nodes / events   │
│ Other agents (L0/L1)      │   │ Transcripts (content-    │
│                           │   │   addressed) / artifacts │
└───────────────────────────┘   └──────────────────────────┘
```

### UI principles

- **Human attention is the bottleneck.** The home screen is an attention queue (`blocked` / `need_decision` / failing tests / budget warnings). The tree is a navigation aid.
- The tree shows semantic checkpoints by default; whole path segments can be collapsed; micro snapshots expand on demand.
- What the AI *claims* is shown separately from what is *verified* (tests, diffStat).
- Forking from any node shows an estimated cost (whether the prompt cache is still warm).

---

## 7. Checkpoint Mechanism

**Decision: AI-declared checkpoints first, with rule-based fallback.**

### 7.1 AI-declared

turtle exposes an MCP tool:

```
turtle_checkpoint(
  summary: string,
  status: "progress" | "done" | "blocked" | "need_decision",
  artifacts?: ArtifactRef[]
)
```

The system prompt instructs the agent to call it when it finishes a sub-goal, changes direction, or needs a human decision. `blocked` / `need_decision` go straight into the attention queue.

### 7.2 Rule-based fallback

If the AI has not declared a checkpoint for a while, turtle inserts one automatically when any of these triggers fire:

- More than N tool calls or M minutes
- Changed lines / files exceed a threshold
- Test status flips (fail→pass or pass→fail)

Auto checkpoints are summarized by a small model (e.g. Haiku) from the diff + tool-call list, not the full thinking. The UI renders them in a distinct style.

### 7.3 Micro snapshots

Taken automatically after every tool call, hidden by default, used for fine-grained rewind.

---

## 8. Operation Semantics

| Operation | Semantics |
|---|---|
| **fork(node, instruction)** | Start a new branch from a node; a new agent takes over |
| **explore(node, instruction, N)** | Two phases: ① Plan — one agent lists N *genuinely different* approaches (cheap) ② the human selects ③ Execute — one agent per approach, each told what its siblings are doing. Produces an Exploration Group |
| **kill(agent)** | Stop at the next tool boundary; the final state is saved as a node (status = killed) |
| **redirect(agent, instruction)** | Interrupt at a tool boundary, inject a "direction changed" message into the transcript, continue |
| **human_edit(node)** | The human's change becomes a node (author = human). Running downstream agents rebase onto it at their next tool boundary, **and the human's change is injected into the agent's context** so the agent does not revert it |
| **merge(a, b)** | Itself an agent task that produces a merge node and must run tests (handles semantic conflicts). Conflicts may be stored on the node and resolved later |
| **tag snapshot(node)** | Mark to keep; exempt from GC; reusable |
| **add task(parent, title, deps?, startFrom?)** | Human or agent adds a task to the graph. With `startFrom`, the task forks from that checkpoint when it starts |
| **assign(task, agent \| human)** | Start an agent on the task (new branch, or continue its branch), or mark it as the human's |
| **answer(question)** | Records a decision and unblocks the question's task (today: continue from a need_decision node) |
| **edit / drop(concept)** | Human edits are instructions: the agent on an affected task is redirected at its next tool boundary |
| **export(node)** | Turn the root→node path into clean git history (optionally squashed) as a normal branch / PR |

### Compare view

Sibling branches in an Exploration Group side by side: diff, test results, code size, token spend. Actions: "pick this one", "merge the best of A and B".

---

## 9. Multi-Model: Tiered Adapters

The core (node / tree / VCS / UI) is model-agnostic; only the agent-runtime layer is model-specific.

| Level | Capability | Applies to |
|---|---|---|
| **L0** Filesystem watch | Snapshot from worktree changes only | Any agent (Codex, Gemini CLI, Aider, …) |
| **L1** Structured events | Hooks / event stream: tool-call boundaries and thinking | Agents that expose hooks |
| **L2** Full control | turtle owns the agent loop and transcript: fork from any node, interrupt, inject, prompt cache | Claude Agent SDK (first implementation) |

Provider differences: prompt-cache mechanics and TTL, thinking visibility (Claude thinking blocks are signed and cannot move across models), transcript format, interrupt capability.

Side benefit: transcripts can be converted to a neutral format so **a different model can continue the same branch** (the cache is lost and thinking blocks don't carry over).

---

## 10. Rollback Scope & Execution Environment

**Decision: roll back code only. Prerequisite: the environment must be defined as code.**

> Principle: code + environment-as-code = the complete state; anything not declared is disposable; any irreversible action requires human confirmation.

| Risk | Mitigation |
|---|---|
| Environment rebuilds cost time (not tokens), multiplied by parallel agents | Cache images / dependencies keyed by lockfile hash |
| Database schema out of sync with rolled-back code | One disposable DB per worktree (SQLite file / Postgres template clone / container), rebuilt from seed |
| Irreversible external side effects (email, payments, push, cloud resources) | Intercept and require human confirmation |
| Untracked files (`.env`, build outputs) | Explicit snapshot policy; secrets never enter snapshots |
| Large outputs (model binaries, traces of hundreds of MB) | Never snapshotted: written outside the workspace or under ignored paths, recorded as **outputs** (path + sha256) on the task (§3.1) |
| Shared physical devices and services (a phone, a test DB) | Modeled as **resources** with a lock and a queue; a task declares what it needs and waits its turn. Nodes that touched a resource are marked "has external side effects", and a fork from them warns that the device is not rewound |
| Rebuilding the environment *via AI* costs tokens and is non-deterministic | Have the AI write **deterministic scripts** into the repo; run the scripts afterwards |

### Local containers

- One container per agent. The workspace is a plain directory materialized from a node's tree (no `.git` inside), so agents cannot bypass the orchestrator and write refs. `git diff` / `git log` etc. are provided through turtle's MCP tools. See [phase0-spec.md](./phase0-spec.md) §3.
- macOS bind-mount I/O is slow: put `node_modules` and similar in named volumes.
- API keys are injected by the orchestrator from the host, never baked into images.

---

## 11. Token-Saving Strategy

1. **Forks hit the prompt cache**: a child transcript whose prefix exactly matches the parent's gets cache hits (roughly 10% of the normal input price). Nodes must therefore store the full transcript.
2. **Trade-off once the cache expires**: caches have a TTL (5 min / 1 h). After expiry, choose between a summary chain (cheap, loses detail) and the full transcript (accurate, expensive). The UI shows the estimated cost and lets the human choose.
3. **Kill wrong branches early**: real-time visibility + one-click kill is the biggest saving.
4. **Avoid repeated exploration**: on fork / explore, tell child agents which approaches siblings already tried and failed (as summaries).
5. **Tiered summaries**: summarize only at semantic checkpoints, using a small model.
6. **Explore = Plan, then Execute**: plan cheaply, execute only the approaches the human picks.
7. **Budget caps**: per-branch and per-tree limits on tokens, parallelism, and depth.

---

## 12. Tech Stack

**TypeScript (Node.js or Bun) for both the orchestrator and the Web UI.**

| Consideration | Notes |
|---|---|
| Claude Agent SDK | TypeScript is the primary official SDK |
| Shared types | `Node` / `Event` etc. defined once for backend and frontend |
| Adoption / AI familiarity | Per GitHub Octoverse 2025, TypeScript is the most-used language on GitHub by contributors |
| Performance | The bottleneck is LLM latency (seconds), not CPU; git snapshots take milliseconds |

The snapshot engine starts by calling git plumbing commands directly. If a hotspot appears, rewrite just that part in Rust (gitoxide + napi-rs) — no full rewrite needed.

---

## 13. Scale-up

**Bottom line: the real limits are human attention, API rate limits, and local RAM (number of containers) — not TypeScript.** The following must be designed correctly from day one, because retrofitting them later is expensive.

### 13.1 Node count (thousands to hundreds of thousands)

| Layer | Problem | Mitigation |
|---|---|---|
| SQLite | Fine up to millions of rows | Index `parent`, `agentId`, `status`, `explorationGroupId`; wrap behind an interface so it can move to Postgres |
| git refs | **One ref per node will cripple git** (huge numbers of loose refs) | Create refs only for branch tips and tagged snapshots; every other node is an ancestor of a tip and stays reachable. Use packed-refs or reftable (git ≥ 2.45) |
| git GC | Commits with no ref pointing at them get removed by `git gc` | Keep the tip ref of killed branches until turtle's own GC policy deletes it |
| git objects | Content-addressed, duplicates deduplicated automatically | Periodic `git repack` |

### 13.2 Transcript size

- A child transcript = parent transcript + new messages → **store only the new segment** (append-only segments, each pointing to its parent segment). Forks cost almost no storage.
- Segments are stored on disk by content hash (later swappable for object storage).

### 13.3 Snapshot speed on large repos

- `git add -A` scans the whole tree on a large repo.
- When an agent writes files through tools, turtle already knows the changed paths → build the tree incrementally.
- Bash commands can change any file → use git's fsmonitor / untracked cache as a fallback.

### 13.4 UI

- Push incremental events, never the whole tree; load diffs and transcripts lazily.
- Virtualized tree rendering + collapsing + level-of-detail by zoom.
- Batch token streams from many agents and push at a fixed rate (e.g. 10 Hz).
- Phase 1 status: diffs and transcripts are lazy and incremental, but every change still refetches the whole state and the tree is not virtualized. That is fine for hundreds of nodes; delta sync and virtualization come before thousands ([phase1-spec.md](./phase1-spec.md) §11).

### 13.5 Node.js single thread

- The orchestrator is almost entirely I/O-bound (API calls, git subprocesses, files); one thread is enough.
- CPU-heavy work (large diffs, tree layout) goes to `worker_threads` or the browser.

### 13.6 Moving to cloud / teams (future)

- Abstract Storage and Agent Runtime behind interfaces from the start: SQLite → Postgres, local files → object storage, local containers → remote containers.
- Keep orchestrator state in the DB so it can scale horizontally later.

### 13.7 Where Rust would help

Only if a measured hotspot appears (e.g. snapshotting a very large monorepo). Rewrite that module with gitoxide + napi-rs and keep the rest in TypeScript.

---

## 14. Risks & Open Issues

### Fundamental

1. **Checkpoint granularity**: too fine recreates Observation 1 → two-tier checkpoints + collapsing (§7).
2. **Human attention bottleneck**: the attention queue takes priority over the tree (§6).
3. **Non-code state**: environment-as-code + interception of irreversible actions (§10).

### Technical

4. Race conditions when a human and an AI edit the same worktree (§8 human_edit).
5. Redirect only takes effect at tool boundaries and needs context injection.
6. Merges with semantic conflicts (§8 merge).
7. How much context a fork receives: accuracy vs cost.
8. Summaries can be wrong → tie them to objective verification (§5 `verified`).

### Scale-up

9. Too many git refs degrades git performance → refs only for tips / snapshots (§13.1).
10. Unreferenced commits lost to `git gc` → turtle-managed tip refs and GC policy (§13.1).
11. Transcript storage growth → append-only segment dedup (§13.2).
12. Snapshot latency on large repos → incremental tree build + fsmonitor (§13.3).
13. UI overload with thousands of nodes and many live streams → incremental events, virtualization, batched streaming (§13.4).
14. Parallelism bounded by API rate limits and local RAM → budget/parallelism caps; remote containers later (§11, §13.6).

### Product

15. Who decides to spawn parallel agents? If the AI can branch on its own, it needs budget / depth caps.
16. GC policy for throwaway branches and transcripts. `TODO`
17. Positioning vs existing tools (Claude Code checkpoint/rewind, subagents, Cursor background agents, etc.). With v0.2 also vs project management tools (Linear, Jira): turtle's tasks are executed by agents, carry evidence, and are versioned with the code. `TODO`

### Task graph (v0.2)

18. **The graph drifts from reality.** The agent's claims and its actions diverge. Mitigations:
    - evidence links on every finding and every `done` (§3.1);
    - findings without evidence are shown as *claimed*;
    - at automatic checkpoints, a small model checks the graph against the tool calls.
19. **Graph noise.** Agents may add too many tiny tasks and findings. Mitigations:
    - per-checkpoint limits on new concepts;
    - findings fold under their task;
    - the human can merge or drop nodes.
20. **Concurrent edits.** Human and agent may edit the same concept. Concepts are versioned and the human's edit wins; the agent is told at its next tool boundary.
21. **Combining parallel work.** A task that depends on several parallel tasks needs their results:
    - outputs pass by path, so they need no merge;
    - code from several branches needs a merge (§8), with conflicts going to a merge agent or the human. `TODO` for the Phase 3 spec.
22. **Scheduling.** Dependency cycles are rejected. Resource waits and parallelism caps need to be visible, or the human cannot tell "waiting" from "stuck".

### Many people (v0.3)

23. **Someone else's instruction runs on your machine.** An editor's redirect makes an agent act on the runner of the member it runs for. Mitigations:
    - runners accept work only from allowed members;
    - sandboxes stay on (D11);
    - irreversible actions still need confirmation from the member who owns the runner;
    - every instruction is attributed in the operation log.
24. **Sync conflicts and stale replicas.** Two members may act on old state, for example both starting the same task. Mitigations:
    - a task's start is a claim operation;
    - when the logs merge, the second claim becomes a visible conflict instead of a duplicate run.
25. **Secrets in shared nodes.** Transcripts and tool output can contain tokens and internal paths. Briefs share summaries and evidence only, and a share preview shows exactly what leaves the machine.
26. **Scope.** Sync, permissions and a server are large and do not differentiate turtle. They wait for the Phase 2 gate (§2.1, §15).
27. **Wrong or stale lessons spread.** A lesson injected into every task below a node multiplies its mistakes. Mitigations:
    - lessons carry evidence and a confirmer;
    - agents' lessons stay `proposed` until a human confirms them;
    - a later finding can supersede a lesson;
    - injected lessons are listed in each task's detail, so the human sees exactly what an agent was told.

---

## 15. Phased Plan

| Phase | Scope | Validates |
|---|---|---|
| **0 Record** | CLI wrapping Claude Agent SDK + workspace dir + container + hooks + `turtle` MCP tools → write to `refs/turtle/*` and SQLite. Spec: [phase0-spec.md](./phase0-spec.md) | Data model, checkpoint granularity |
| **1 Web UI** | Web: attention queue, tree, node detail (diff / summary / artifacts), live stream, plus the Phase 0 actions (run / answer / fork / stop / tag / export). Spec: [phase1-spec.md](./phase1-spec.md) | Can a human keep up with the AI? |
| **2 Task graph (single user)** | A turtle project above repositories (several attached repos, multi-repo checkpoints). Concept store with an operation log that is multi-user-ready, plus MCP tools for agents. **Mind map as the main screen**. Humans add, edit and drop tasks. Agent-created tasks start at once (a minimal scheduler: dependencies done + parallelism cap), with notifications, Pause and Drop. A task runs one agent; starting from another task's checkpoint is a fork. **Stop and redirect from the graph.** Abandon an approach with a lesson and retry from an earlier checkpoint. Node briefs and static export. Phase 0–1 runs import as tasks. Spec: [phase2-spec.md](./phase2-spec.md) | Is the graph a faithful, rewindable, shareable record of the work? **Gate for Phase 4**, measured passively from the records: (G1) rewindable, meaning checkpoints resumable and forks succeed; (G2) truthful, meaning evidence ratio and audit agreement; (G3) shareable, meaning exported briefs stand on their own; (G4) affordable, meaning tokens per finished task; reported with them: (G5) reproducible, meaning hardened steps redo themselves (§3.7) |
| **3 Parallel tasks & explore** | Full scheduler (a background daemon, budgets across tasks). Resources with locks and queues. Output store outside git. Combining upstream work (outputs by path, code via a merge agent). Explore = N sibling tasks plus a compare view. Project-wide lesson search (§3.5). Resources marked `confirm: always` | Value and cost of parallel and alternative work |
| **4 Many people** | Replicas synced through a git remote (per-replica op refs, merge of logs, surfaced conflicts). Roles on projects and subtrees. Agents on behalf of members. Requests from commenters | Can several people steer one graph without stepping on each other? |
| **5 turtle server** | Live share links, per-node permissions, comments from people without turtle, shared runners (e.g. a lab machine with phones) | Sharing nodes instead of documents |
| **6 Depth** | human_edit with downstream rebase, L0/L1 adapters for other agents and models, token optimization across tasks, scale-up work (§13) | Generality and cost |

---

## 16. Decision Log

| # | Topic | Decision |
|---|---|---|
| D1 | VCS foundation | git object store + SQLite metadata, jj-style semantics; orchestrator is the sole ref writer |
| D2 | Usage modes | Monitor/control + explore; any branch can be explored manually |
| D3 | Models | Generic tiered adapters (L0/L1/L2); Claude Agent SDK first |
| D4 | Rollback scope | Code only; environment defined as code |
| D5 | Execution environment | Local + one container per agent (early phases) |
| D6 | UI | Web |
| D7 | Checkpoints | AI-declared first, rule-based fallback, micro snapshots hidden by default |
| D8 | Language | TypeScript; Rust only for measured hotspots |
| D9 | Runtime | Node.js (≥ 22, 24 LTS recommended), pnpm workspace |
| D10 | Workspace | Plain directory materialized from a node's tree + per-branch index; not a git worktree |
| D11 | Sandbox boundary | The agent runner (Agent SDK) runs inside the container; the orchestrator stays on the host and talks to it over JSONL stdio |
| D12 | UI transport | HTTP for commands, Server-Sent Events for pushes; the server detects changes by polling SQLite `data_version`, so runs in other processes show up live |
| D13 | Phase 1 scope | The web UI also exposes the actions the Phase 0 CLI already had (run, answer/continue, fork, stop, tag, export); `turtle ui` is itself an orchestrator for runs started from the browser |
| D14 | UI security | Loopback only; Host check against DNS rebinding; writes require a custom header + JSON (forced CORS preflight, never approved); artifacts served in a CSP sandbox |
| D15 | Product shape | An agent-native project management tool: a task graph (mind map) shared by humans and agents; the code tree is its evidence layer (§3.1) |
| D16 | Who edits the graph | Both. Agents through MCP tools, humans in the UI; every edit is a versioned event, and human edits act as instructions |
| D17 | What a node is | A task is a unit of work: assignable to an agent, with dependencies and resources; its work runs on a code branch |
| D18 | Main screen | The mind map; the code tree is a drill-down from a task |
| D19 | Non-code state | D4 stands: environment as code, no container snapshots. External devices and services are resources (lock + queue + side-effect marks); large outputs live outside git, recorded by path + sha256 |
| D20 | Users | Single user first (Phase 2); the data model is multi-user from the start (actors, replicas, roles); turtle aims to be a general, multi-user system like git |
| D21 | Agent-created tasks | Start immediately; humans are informed, not asked: new nodes are flagged and batched in an Activity feed (not *Needs you*), with Pause / Drop one click away; caps queue the excess |
| D22 | Sharing | The node is the unit of sharing; its brief is kept current by the agent; transcripts, env and local paths are not shared by default |
| D23 | Project scope | A turtle project is its own repository above code repositories; tasks touch 0..n repositories; a checkpoint is a set of per-repository commits |
| D24 | Multi-user model | Local-first replicas; per-replica op refs; the graph is the merge of all logs; same-field conflicts are surfaced; sync through any git remote first, a turtle server later |
| D25 | Permissions | Roles owner / editor / commenter / viewer on a project or subtree; commenter requests need the task owner's acceptance |
| D26 | Agent identity | An agent acts on behalf of one member, on a runner that member may use (own machine or a shared lab runner); only editors start agents |
| D27 | Core | Concepts + operations + links + checkpoints form the core; scheduling, UI, notifications and permissions are built on top |
| D28 | Failed approaches | Abandon, do not delete; turtle drafts a lesson, the human edits it; the lesson hangs on the node rewound to; the retry is a sibling task forked from a checkpoint before the failure and receives the lessons, audited against them |
| D29 | Irreversible resources | Resources can require confirmation (`confirm: always`); agents stop and ask before using them |
| D30 | Memory | The task graph is the memory: lessons, findings, decisions with provenance and scope; retrieval by scope (Phase 2), project search over a rebuildable index (Phase 3), shared across projects later (Phase 5) |
| D31 | Hardening | Intent that worked and lessons that must hold become code turtle runs, in the agent's sandbox: L1 checks (scripts stored in the graph, run at every checkpoint in scope, a failing check blocks `done`; agents only propose), L2 recipes (verified by a clean replay from the checkpoint; replays with parameters run without a model, and an agent repairs only what fails), L3 policies (D29). Language-neutral contract: exit code 0 passes; Python by default, with `turtle_check` helpers for tolerances |

## 17. TODO

- [x] **Q4**: concrete user scenarios → first one: measuring a model's power/performance on a phone (§3.1)
- [ ] User scope: individual vs team (currently assuming individual)
- [ ] GC policy for throwaway branches / transcripts
- [x] Node.js vs Bun → Node.js (D9)
- [ ] Positioning vs existing tools
- [x] Detailed Phase 0 spec → [phase0-spec.md](./phase0-spec.md)
- [x] Phase 1 spec → [phase1-spec.md](./phase1-spec.md); manual test guide → [tutorial.md](./tutorial.md)
- [x] Task-graph direction (v0.2, D15–D19); validated with a clickable mind-map prototype of the phone scenario
- [x] Phase 2 spec (task graph) → [phase2-spec.md](./phase2-spec.md)
- [x] Single user vs team → single user first, multi-user model (D20, D24–D26)
- [x] Cross-repo → a turtle project above repositories (D23)
- [ ] Phase 0–1 manual verification on macOS (validates the code-layer engine the project reuses)
