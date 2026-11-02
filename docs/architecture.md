# turtle — Architecture Design (Draft v0.1)

> Status: under discussion, not yet implemented. Items marked `TODO` are open questions.

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

## 3. Core Idea: Two Trees

| Tree | Content | Today |
|---|---|---|
| Code-state DAG | What the code looks like | Solved by git |
| Process / intent tree | Who, under which instruction, thought what, spent how many tokens, and why it branched | **Nobody handles this** |

**turtle's core value is linking the two trees**: every code snapshot can answer "which intent did this come from, and what was the context at the time?"

### Glossary

- **Node**: a checkpoint — one commit plus intent/process metadata.
- **Micro snapshot**: an automatic snapshot after every tool call; hidden in the UI by default.
- **Semantic checkpoint**: a meaningful milestone (declared by the AI or triggered by a rule); shown in the UI by default.
- **Exploration Group**: the set of sibling branches produced by one `explore` operation.
- **Snapshot (human-tagged)**: a node a human marks to keep and reuse.

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

interface Event {              // like jj's operation log; append-only
  id: string;
  at: string;
  actor: { type: "agent" | "human" | "system"; id: string };
  type:
    | "tool_call" | "checkpoint" | "fork" | "explore" | "kill"
    | "redirect" | "human_edit" | "merge" | "tag" | "rebase" | "gc";
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
                │ WebSocket (events)       │ HTTP (commands)
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
│ 1 container + 1 git       │   │ git object store         │
│   worktree per agent      │   │   refs/turtle/*          │
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
| Rebuilding the environment *via AI* costs tokens and is non-deterministic | Have the AI write **deterministic scripts** into the repo; run the scripts afterwards |

### Local containers

- One container per agent, mounting only the worktree's working files, **not `.git`** (so agents cannot bypass the orchestrator and write refs). `git diff` / `git log` etc. are provided through turtle's MCP tools.
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
17. Positioning vs existing tools (Claude Code checkpoint/rewind, subagents, Cursor background agents, etc.). `TODO`

---

## 15. Phased Plan

| Phase | Scope | Validates |
|---|---|---|
| **0 Record** | CLI wrapping Claude Agent SDK + worktree + container + hooks + `turtle_checkpoint` MCP → write to `refs/turtle/*` and SQLite | Data model, checkpoint granularity |
| **1 Read-only UI** | Web: attention queue, tree, node detail (diff / summary / artifacts), live stream | Can a human keep up with the AI? |
| **2 Control** | kill / fork / redirect / human_edit / tag snapshot | Timing and semantics of intervention |
| **3 Explore & merge** | explore (Plan → select → Execute), compare view, merge agent, export to git, sharing failed attempts across branches, token optimization | Value and cost of parallel exploration |

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

## 17. TODO

- [ ] **Q4**: concrete user scenarios (to walk the data flow end-to-end and validate the architecture)
- [ ] User scope: individual vs team (currently assuming individual)
- [ ] GC policy for throwaway branches / transcripts
- [ ] Node.js vs Bun
- [ ] Positioning vs existing tools
- [ ] Detailed Phase 0 spec (directory layout, MCP tool definitions, SQLite schema)
