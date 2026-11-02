# turtle — Phase 0 Spec: Record

> Status: draft for review. Parent document: [architecture.md](./architecture.md).
> Items marked **VERIFY** are assumptions about external tools to confirm during implementation.

---

## 1. Goal

Phase 0 builds the **recording layer**: one AI agent works on a task while turtle turns its work into a tree of checkpoints stored in git + SQLite. There is no Web UI yet; a CLI is enough to run agents and inspect the tree.

### Questions Phase 0 must answer

1. Is the data model (§6, §7) enough to reconstruct *what happened and why*?
2. Is the checkpoint granularity right — are semantic checkpoints frequent enough to steer by, yet few enough to read?
3. Is snapshotting fast enough to run after every tool call?
4. What does checkpointing cost in tokens (summaries + checkpoint tool calls)?
5. Can we continue or fork from any semantic checkpoint (resume the agent's conversation at that point)?

### Exit criteria

| # | Criterion |
|---|---|
| E1 | At least 5 real tasks run end-to-end on turtle's own repo (dogfooding) |
| E2 | Hour-long runs produce 3–15 semantic checkpoints (rules tuned until they do) |
| E3 | Snapshot p95 < 300 ms on a 10k-file repo |
| E4 | Checkpoint overhead (summarizer + checkpoint tool calls) < 5% of run cost |
| E5 | `turtle run --from <node>` works from a mid-run semantic node, in both sandbox modes |
| E6 | Ctrl-C at any moment leaves git refs, DB and workspace consistent |

### Non-goals (later phases)

Web UI and live attention queue (Phase 1) · redirect / inject / human_edit while an agent runs (Phase 2) · explore, compare view, merge (Phase 3) · adapters other than Claude Agent SDK · remote containers · teams.

---

## 2. User Workflow

```
$ turtle init
$ turtle run "Add a --json flag to the export command"
branch b3kq  root r7xm  (HEAD a1b2c3d + 2 uncommitted files)
  · Read   src/export.ts
  · Edit   src/export.ts
  ◆ k2pz  progress       Add --json option parsing            +42 −3  2 files
  · Bash   npm test                                            tests ✗
  ◆ x9df  need_decision  Should --json include nested objects?
run ended (need_decision) — to answer:
  turtle run --from x9df "Yes, include nested objects"

$ turtle run --from x9df "Yes, include nested objects"     # continues branch b3kq
$ turtle run --from k2pz --fork "Use a streaming JSON writer"   # new branch from k2pz
$ turtle log
$ turtle show x9df --diff
$ turtle export <node> --branch feat/json-export
```

- `·` lines are tool calls. Micro snapshots are hidden unless `--all` is used.
- `◆` lines are semantic checkpoints (declared by the agent, or added by rules and marked `auto`).
- `need_decision` / `blocked` end the run. The human answers with `turtle run --from`.

---

## 3. Process Architecture

```
┌──────────────────────── host ─────────────────────────┐
│ turtle CLI process  = orchestrator for this run        │
│  • git store (sole ref writer)  • SQLite (WAL)         │
│  • checkpoint engine + rules    • summarizer (Haiku)   │
│  • terminal renderer                                   │
│            ▲ JSONL over stdio (protocol §8)            │
│            ▼                                           │
│  ┌──────── sandbox: docker container | child process ┐│
│  │ runner-claude                                     ││
│  │  Claude Agent SDK query() in streaming-input mode ││
│  │  hooks: PostToolUse, Stop                         ││
│  │  in-process MCP server "turtle": checkpoint,      ││
│  │    diff, history (forwarded to orchestrator)      ││
│  │  cwd = workspace (/workspace in docker)           ││
│  └───────────────────────────────────────────────────┘│
│  workspace dir ◄── bind mount ──┘  (no .git inside)    │
└────────────────────────────────────────────────────────┘
```

Design decisions:

- **The runner, not the orchestrator, runs inside the sandbox.** The Agent SDK runs Claude Code as a subprocess and executes tools where it runs, so the whole SDK must live in the container. The orchestrator stays on the host and owns git and the DB.
- **The protocol is the adapter boundary.** Any runner that speaks the §8 protocol is an adapter. A future L0 adapter for another CLI agent only needs to emit file-change requests.
- **Workspace = plain directory, not a git worktree.** turtle materializes a node's tree into an empty directory and snapshots it with `git --work-tree=<ws>` plus a per-branch index file. No `.git` file sits in the workspace, so agents cannot touch refs, and there is no worktree bookkeeping.
- **One orchestrator process per run.** Several `turtle run` processes may run concurrently; they share SQLite (WAL) and only write their own branch refs. Phase 1 replaces this with a daemon that reuses the same library code.
- **Streaming-input mode** (`prompt` as an `AsyncIterable<SDKUserMessage>`) from day one: it is required for `interrupt()` and is how Phase 2 will inject messages.

---

## 4. Repository Layout

pnpm workspace, TypeScript (ESM, strict), Node.js ≥ 22 (24 LTS recommended), vitest, Biome.

```
turtle/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json
  packages/
    protocol/        # orchestrator ↔ runner message types (no runtime deps)
    core/            # git store, DB, ids, config, checkpoint engine, rules, summarizer,
                     #   sandbox launchers, run orchestration (library, no CLI I/O)
      src/git/       #   exec, snapshot, materialize, refs, blobs, diff
      src/db/        #   schema.sql, migrate, repositories
      src/run/       #   orchestrator, checkpoint, rules, summarizer, sandbox
    runner-claude/   # Agent SDK runner (runs in the sandbox)
    cli/             # `turtle` command + terminal rendering
  docker/
    runner-claude.Dockerfile
  docs/
```

pnpm is a **development-only** tool for working on turtle itself. End users never need it: turtle ships as one npm package with a `turtle` command (`npm install -g <package>` or `npx <package>`; the npm name is TBD because `turtle` is likely taken), plus the runner image for docker mode. A standalone binary is a later option.

Key dependencies: `@anthropic-ai/claude-agent-sdk` (runner), `@anthropic-ai/sdk` (summarizer), `better-sqlite3`, `zod`, `commander`. Git is invoked as the `git` binary (≥ 2.40) via `execFile`; no libgit2 binding in Phase 0.

> `node:sqlite` could replace `better-sqlite3` and remove the native dependency; decide when Node 24 is the minimum.

---

## 5. On-disk Layout

| Path | Content |
|---|---|
| `<git-common-dir>/turtle/turtle.db` | SQLite database (WAL) |
| `<git-common-dir>/turtle/index/<branchId>` | Per-branch git index file (stat cache for fast `add -A`) |
| `<git-common-dir>/turtle/claude/` | `CLAUDE_CONFIG_DIR` for runners (session transcripts live here) |
| `<git-common-dir>/turtle/logs/<agentId>.log` | Runner stderr |
| `<git-common-dir>/turtle/run/<agentId>.pid` | PID of the orchestrator owning a running agent |
| `~/.turtle/workspaces/<repoId>/<branchId>/` | Workspaces (`repoId` = short hash of the repo path) |
| `<repo>/turtle.config.json` | Project config (committed by the user) |

Keeping state under `.git/` means it travels with the repo and can never be committed by accident.

---

## 6. Git Storage

### 6.1 Refs

| Ref | Points to |
|---|---|
| `refs/turtle/branches/<branchId>` | Head commit of a turtle branch |
| `refs/turtle/snapshots/<name>` | Human-tagged node (`turtle tag`) |

Only tips and snapshots get refs (architecture §13.1). Every node commit is an ancestor of a branch tip, so it stays reachable. A branch ref is deleted only by turtle's own GC.

### 6.2 Commit format

Every node is a git commit. The commit message alone can rebuild the DB row (see §6.6):

```
Add --json option parsing

Parses --json and threads it into the exporter. Tests not run yet.

Turtle-Node: k2pzq7wd
Turtle-Kind: semantic
Turtle-Status: progress
Turtle-Branch: b3kqf0ma
Turtle-Agent: a8c1x2vn
Turtle-Summary-Source: agent_declared
```

- Author/committer: `turtle-agent <agent@turtle.invalid>` for agent nodes; the user's git identity for root nodes.
- Micro snapshots use the first line `micro: after <ToolName>`.
- A semantic checkpoint always creates its own commit, even when its tree equals its parent's.

### 6.3 Snapshot algorithm

```
snapshot(branch, kind, meta):                     # serialized per branch (mutex)
  env GIT_INDEX_FILE=<turtle>/index/<branch.id>
  git --git-dir=<repo>/.git --work-tree=<ws> add -A    # honors .gitignore in ws
  tree   = git write-tree
  if kind == micro and tree == branch.headTree: return null     # nothing changed
  commit = git commit-tree <tree> -p <branch.headCommit> -F <message>
  git update-ref refs/turtle/branches/<id> <commit> <branch.headCommit>   # compare-and-swap
  stats  = git diff-tree --numstat -r <branch.headTree> <tree>
  DB tx: insert node + node_parents + event; update branch.head_node_id
```

Order matters: commit → ref → DB. A crash between ref and DB leaves a commit that the reconciler (§6.6) imports at next start.

### 6.4 Root node

`turtle run` without `--from` snapshots the user's current working tree, uncommitted changes included. turtle seeds a temp index with `git read-tree HEAD`, runs `add -A` against the repo root, and creates a commit whose parent is `HEAD`. `--from-head` skips uncommitted changes.

### 6.5 Materialize a workspace

```
mkdir <ws>     (must be empty)
env GIT_INDEX_FILE=<turtle>/index/<branchId>
git --git-dir=<repo>/.git --work-tree=<ws> read-tree <commit>
git --git-dir=<repo>/.git --work-tree=<ws> checkout-index -a
copy config.workspace.copyIgnored (e.g. .env) from the repo root, if present
```

Ignored files (e.g. `node_modules`) are **not** carried across forks. `workspace.setupCommand` (e.g. `npm ci`) runs in the sandbox before the agent starts, following the environment-as-code rule.

### 6.6 Artifacts and reconciliation

- Artifacts (screenshots, logs, test output) are stored as git blobs (`git hash-object -w`) and listed in the `artifacts` table, so they are content-addressed too.
- At startup, the **reconciler** walks `refs/turtle/*`. It imports commits that carry a `Turtle-Node` trailer but have no DB row, and marks agents whose PID is dead as `failed`.

---

## 7. SQLite Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version, repo_id

CREATE TABLE branches (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  ref                 TEXT NOT NULL UNIQUE,
  root_node_id        TEXT NOT NULL,
  forked_from_node_id TEXT,                    -- NULL for a fresh run
  head_node_id        TEXT,
  workspace_path      TEXT,
  status              TEXT NOT NULL,           -- running | idle | done | killed | failed
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  branch_id      TEXT NOT NULL REFERENCES branches(id),
  adapter        TEXT NOT NULL,                -- 'claude-agent-sdk'
  adapter_level  INTEGER NOT NULL,             -- 0 | 1 | 2
  model          TEXT,
  sandbox        TEXT NOT NULL,                -- none | docker
  session_id     TEXT,
  prompt         TEXT NOT NULL,
  status         TEXT NOT NULL,                -- starting | running | done | killed | failed
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  total_cost_usd REAL,                         -- from the SDK result message
  num_turns      INTEGER,
  pid            INTEGER
);

CREATE TABLE nodes (
  id                   TEXT PRIMARY KEY,       -- stable change-id style (12 chars base32)
  branch_id            TEXT NOT NULL REFERENCES branches(id),
  agent_id             TEXT REFERENCES agents(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('root','micro','semantic','human_edit','merge')),
  commit_sha           TEXT NOT NULL,
  tree_sha             TEXT NOT NULL,
  intent               TEXT,
  summary              TEXT,
  summary_source       TEXT CHECK (summary_source IN ('agent_declared','rule_auto','human')),
  status               TEXT NOT NULL,          -- progress | done | blocked | need_decision | killed | failed
  trigger              TEXT,                   -- tool:<name> | declared | rule:<name> | stop | interrupt
  session_id           TEXT,
  resume_tool_use_id   TEXT,                   -- tool call whose result marks the resume point (§10)
  resume_message_uuid  TEXT,                   -- uuid of the message carrying that tool_result; filled when it arrives
  tests                TEXT CHECK (tests IN ('pass','fail','none')),
  files_changed        INTEGER,
  lines_added          INTEGER,
  lines_deleted        INTEGER,
  tokens_input         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write   INTEGER NOT NULL DEFAULT 0,
  tokens_output        INTEGER NOT NULL DEFAULT 0,
  cost_usd_est         REAL    NOT NULL DEFAULT 0,
  tags                 TEXT    NOT NULL DEFAULT '[]',
  exploration_group_id TEXT,                   -- unused until Phase 3
  created_at           TEXT NOT NULL
);
CREATE INDEX nodes_branch ON nodes(branch_id, created_at);
CREATE INDEX nodes_status ON nodes(status) WHERE kind = 'semantic';

CREATE TABLE node_parents (
  node_id   TEXT NOT NULL REFERENCES nodes(id),
  parent_id TEXT NOT NULL REFERENCES nodes(id),
  ord       INTEGER NOT NULL,
  PRIMARY KEY (node_id, ord)
);
CREATE INDEX node_parents_parent ON node_parents(parent_id);

CREATE TABLE artifacts (
  id       TEXT PRIMARY KEY,
  node_id  TEXT NOT NULL REFERENCES nodes(id),
  label    TEXT,
  path     TEXT,                                -- path in the workspace when captured
  blob_sha TEXT NOT NULL,
  mime     TEXT,
  size     INTEGER
);

CREATE TABLE messages (                         -- every SDK message, verbatim
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  seq                INTEGER NOT NULL,
  session_id         TEXT,
  uuid               TEXT,
  type               TEXT NOT NULL,             -- assistant | user | system | result
  parent_tool_use_id TEXT,
  node_id            TEXT,                      -- first node created after this message
  json               TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX messages_uuid ON messages(session_id, uuid);

CREATE TABLE events (                           -- append-only operation log
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  at         TEXT NOT NULL,
  actor_type TEXT NOT NULL,                     -- agent | human | system
  actor_id   TEXT,
  type       TEXT NOT NULL,                     -- run_start | tool_call | checkpoint | fork | kill | tag | export | gc | run_end
  branch_id  TEXT,
  node_id    TEXT,
  agent_id   TEXT,
  payload    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE snapshots (
  name       TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  created_at TEXT NOT NULL
);
```

IDs: 12 random characters (60 bits) from a lowercase base32 alphabet, shown to humans by the shortest unique prefix (min 4), as jj does. Prefixes: none for nodes; branches and agents are distinguishable by table, not by prefix.

Token accounting: each node sums `message.usage` from assistant messages since the previous node (main loop and subagents). `cost_usd_est` uses a price table in config. The run's authoritative cost is the SDK result's `total_cost_usd` (per-model detail in `modelUsage`). Summarizer calls are recorded as `checkpoint` event payloads so overhead (E4) can be measured separately.

---

## 8. Orchestrator ↔ Runner Protocol

Newline-delimited JSON over the runner's stdin/stdout. The runner writes logs only to stderr. `id` correlates a request with its reply.

```ts
// orchestrator → runner
type ToRunner =
  | { t: "start"; prompt: string; options: RunnerStartOptions }
  | { t: "reply"; id: number; ok: true; result: unknown }
  | { t: "reply"; id: number; ok: false; error: string }
  | { t: "exec"; id: number; cmd: string; timeoutSec: number }   // setup / test commands
  | { t: "interrupt" }
  | { t: "shutdown" };

interface RunnerStartOptions {
  model?: string;
  systemPromptAppend: string;
  resume?: string;            // SDK session id
  resumeSessionAt?: string;   // message uuid to resume at
  forkSession?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode: "bypassPermissions" | "acceptEdits";
  allowedTools?: string[];
}

// runner → orchestrator
type FromRunner =
  | { t: "ready"; adapter: "claude-agent-sdk"; level: 2; capabilities: string[]; version: string }
  | { t: "sdk"; msg: unknown }                                     // every SDKMessage, verbatim
  | { t: "request"; id: number; kind: "post_tool_use"; toolName: string; toolUseId: string;
      toolInput: unknown; toolResponse: unknown; agentId?: string }
  | { t: "request"; id: number; kind: "checkpoint"; summary: string;
      status: "progress" | "done" | "blocked" | "need_decision";
      artifacts?: { path: string; label?: string }[] }
  | { t: "request"; id: number; kind: "diff"; since?: string; path?: string }
  | { t: "request"; id: number; kind: "history"; limit?: number }
  | { t: "request"; id: number; kind: "stop"; lastAssistantMessage?: string }
  | { t: "exec_result"; id: number; exitCode: number; stdout: string; stderr: string }
  | { t: "exit"; code: number; error?: string };
```

`post_tool_use` blocks the agent until the orchestrator replies, so the snapshot reflects exactly the state after that tool. Snapshots are serialized per branch, so concurrent tool calls from parallel calls or subagents queue up.

---

## 9. Claude Runner (`runner-claude`)

### 9.1 SDK call

```ts
const q = query({
  prompt: inputStream,                      // AsyncIterable<SDKUserMessage>, kept open
  options: {
    cwd: workspace,                         // /workspace in docker
    model, maxTurns, maxBudgetUsd,
    resume, resumeSessionAt, forkSession,
    permissionMode, allowedTools,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
    mcpServers: { turtle: turtleMcpServer },
    hooks: {
      PostToolUse: [{ hooks: [postToolUse] }],
      Stop:        [{ hooks: [onStop] }],
    },
    env: { ...process.env },                // env replaces, not merges
  },
});
for await (const msg of q) send({ t: "sdk", msg });
```

`interrupt` → `q.interrupt()`. Shutdown → `q.close()`.

### 9.2 MCP tools (server `turtle`, so the model sees `mcp__turtle__*`)

| Tool | Input | Behavior |
|---|---|---|
| `checkpoint` | `summary` (commit-message style), `status`, `artifacts?` | Forwards a `checkpoint` request; returns `Checkpoint <id> recorded.` For `need_decision` / `blocked`, the reply also tells the agent to end its turn with one short question |
| `diff` | `since?` (`branch_start` \| `last_checkpoint` \| node id), `path?` | Unified diff from the orchestrator, truncated to 30k chars with a note |
| `history` | `limit?` | Semantic summaries of this branch's ancestors, newest first |

The workspace has no `.git`, so these tools replace `git diff` / `git log` for the agent.

### 9.3 Hooks

- **PostToolUse** (all tools): sends `post_tool_use` and waits for the reply. The orchestrator skips the snapshot for read-only tools (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `TodoWrite`, `mcp__turtle__*`) and only counts them.
- **Stop**: sends `stop`. The orchestrator writes a final semantic checkpoint (`trigger: stop`) if files changed since the last semantic node or the agent never declared one, then shuts the runner down.

### 9.4 System prompt append (draft)

```
You are working inside turtle, which records your work as a tree of checkpoints.
- Your working directory is a snapshot of the project with no .git directory.
  Use mcp__turtle__diff and mcp__turtle__history instead of git.
- Call mcp__turtle__checkpoint when you finish a meaningful sub-goal, before you
  change approach, and when you need a human decision. Write the summary like a
  commit message: a first line under 72 characters, then what changed and why.
- Files are snapshotted automatically after every edit; do not checkpoint every edit.
- Use status "need_decision" or "blocked" only when you cannot continue without the
  human. After such a checkpoint, end your turn with one short question.
```

---

## 10. Continue and Fork

`turtle run --from <node> "<message>"`:

| Case | Behavior |
|---|---|
| `<node>` is the head of its branch, the branch is not running, no `--fork` | **Continue**: same branch and workspace; resume the SDK session (`resume = node.session_id`) |
| Otherwise, or `--fork` | **Fork**: new branch whose root parent is `<node>`; materialize `<node>`'s tree into a new workspace; `resume = node.session_id`, `resumeSessionAt = node.resume_message_uuid`, `forkSession = true` |

**Where to cut the conversation.** The Messages API requires every `tool_use` block to be answered by a `tool_result` in the next user message, so a transcript cut between the two is invalid. A resume point must therefore sit **after** the tool result:

- Each node records the `tool_use_id` that produced it (`resume_tool_use_id`): the `mcp__turtle__checkpoint` call for declared nodes, or the tool call whose PostToolUse hook triggered a micro or rule-based node.
- The hook fires before the result is appended to the transcript, so the uuid is not known yet. The orchestrator fills `resume_message_uuid` when the SDK emits the user message that carries that `tool_result`. If the assistant turn made several parallel tool calls, the cut goes after the last of their results.
- A fork then appends the human's new message after that point. Cutting only removes a suffix and never edits the kept prefix, so prompt-cache hits and thinking blocks in the prefix stay valid.

**VERIFY** (milestone M4):

- `resumeSessionAt` accepts the uuid of a user (tool-result) message, and how the SDK emits results of parallel tool calls (one user message or several).
- Session lookup depends on `cwd`. Docker mode always uses `/workspace` with a shared `CLAUDE_CONFIG_DIR`, so lookups match. In `none` mode, workspaces have different paths, so turtle copies the session file into the target project directory before resuming.

---

## 11. Sandbox

| Mode | How | Permission mode | Use |
|---|---|---|---|
| `docker` (default) | `docker run --rm -i --name turtle-<agentId> --user <uid>:<gid> -v <ws>:/workspace -v <turtle>/claude:/turtle/claude -e CLAUDE_CONFIG_DIR=/turtle/claude -e HOME=/tmp/home -e ANTHROPIC_API_KEY -w /workspace <image> turtle-runner` | `bypassPermissions` | Normal runs |
| `none` | Child process on the host, `cwd = <ws>` | `acceptEdits` + `allowedTools` from config | Development / no Docker. Less isolated |

- `--user <uid>:<gid>` keeps workspace files owned by the host user.
- The base image `docker/runner-claude.Dockerfile` is `node:24-bookworm-slim` plus git, ripgrep and the runner build. Projects extend it for their toolchains and set `sandbox.image`.
- The network stays enabled (the agent needs the API). Egress control is out of scope for Phase 0.
- Credentials are passed only as environment variables from the host, never baked into images.
- **Kill**: first Ctrl-C → `interrupt`, final node `status: killed`; second Ctrl-C or 10 s timeout → `docker kill` / `SIGKILL`.

---

## 12. Configuration (`turtle.config.json`)

```json
{
  "agent": {
    "adapter": "claude-agent-sdk",
    "model": "claude-opus-5-5",
    "maxTurns": 200,
    "maxBudgetUsd": 10,
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "mcp__turtle__*"]
  },
  "sandbox": { "mode": "docker", "image": "turtle/runner-claude:0.1" },
  "workspace": { "copyIgnored": [".env"], "setupCommand": "npm ci" },
  "checkpoint": {
    "summarizerModel": "claude-haiku-5-5",
    "rules": {
      "maxToolCalls": 25,
      "maxMinutes": 10,
      "maxChangedLines": 400,
      "maxChangedFiles": 15,
      "testFlip": true
    }
  },
  "tests": { "command": "npm test", "runAtCheckpoint": false, "timeoutSec": 600 },
  "prices": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 } }
}
```

Every field is optional. Prices are in USD per million tokens and are used only for `cost_usd_est`.

---

## 13. Checkpoint Engine

| Kind | Trigger | Summary |
|---|---|---|
| micro | `post_tool_use` for a mutating tool, only when the tree changed | `micro: after <Tool>` |
| semantic (declared) | `mcp__turtle__checkpoint` | The agent's own text (`agent_declared`) |
| semantic (rule) | After a micro snapshot, if any rule fires since the last semantic node | Summarizer (`rule_auto`) |
| semantic (stop) | Stop hook (§9.3) | Summarizer (`rule_auto`) |
| semantic (interrupt) | Ctrl-C | Summarizer, `status: killed` |

**Rules** (counted since the last semantic node): `maxToolCalls`, `maxMinutes`, `maxChangedLines` (sum of numstat), `maxChangedFiles`, `testFlip`.

**Test status.** When `tests.command` is set and a `Bash` call's command contains it, turtle reads the result from `tool_response`. **VERIFY**: whether the Bash `tool_response` exposes an exit code; if not, parse the output for common runner summaries, or rely on `runAtCheckpoint`. With `runAtCheckpoint: true`, the orchestrator sends `exec` to the runner at each semantic checkpoint. A pass↔fail change fires `testFlip`.

**Summarizer.** Uses `@anthropic-ai/sdk` `messages.create` with `summarizerModel`. Input: the branch intent, diffstat, unified diff truncated to 20k chars, tool calls since the last semantic node (name + short input), and the last assistant text. Output: a title under 72 characters plus at most 5 bullet lines. The summarizer never sees thinking blocks.

---

## 14. CLI

| Command | Purpose |
|---|---|
| `turtle init` | Create `.git/turtle/`, the DB, and a default `turtle.config.json` if absent; check Docker and the image |
| `turtle run "<prompt>" [--from <node>] [--fork] [--from-head] [--sandbox docker\|none] [--model m] [--budget usd] [--name label]` | Start, continue or fork (§10); stream progress to the terminal |
| `turtle status` | Running agents and semantic nodes in `need_decision` / `blocked` (text version of the attention queue) |
| `turtle log [--all] [--branch b]` | Tree of semantic nodes across branches (`--all` adds micro snapshots) |
| `turtle show <node> [--diff] [--transcript] [--artifacts]` | Node detail: summary, status, stats, tokens, diff vs parent, transcript slice |
| `turtle checkout <node> [dir]` | Materialize a node into a directory for human inspection |
| `turtle tag <node> <name>` | Create `refs/turtle/snapshots/<name>` |
| `turtle export <node> --branch <name>` | Create a normal git branch: one squashed commit (tree of `<node>`, parent = root's parent) whose message lists the semantic summaries along the path |
| `turtle stop <branch>` | Interrupt a running agent through its PID file |
| `turtle gc [--workspaces]` | Delete workspaces of finished branches (their content is in git) |
| `turtle doctor` | Check consistency: every ref has DB rows, every node commit exists, no orphan running agents or workspaces |
| `turtle stats [--criteria]` | Metrics per run (§16); `--criteria` prints pass/fail against E1–E6 |

---

## 15. Testing Strategy

| Layer | How |
|---|---|
| Git store | vitest against temp repos: snapshot no-op, ignore rules, CAS conflicts, materialize round-trip, numstat |
| DB | Migrations, repositories, reconciler (commit with trailers but no row) |
| Orchestrator | **FakeRunner**: a scripted in-process runner speaking §8 over streams. Covers rules, ordering, interrupt and crash recovery with zero API cost |
| Runner | Unit tests with the SDK mocked; protocol contract tests shared with FakeRunner |
| End-to-end | Gated by `TURTLE_E2E=1` with a real API key; one small task per sandbox mode, including fork from a mid-run node (E5) |

---

## 16. Metrics and User Acceptance

Recorded per run in `events`, printed by `turtle show --stats` / `turtle log --stats`:

- Micro, declared and rule-based node counts; tool calls between semantic nodes (E2)
- Snapshot latency p50 / p95 (E3)
- Summarizer tokens and cost; checkpoint tool calls; both as a share of run cost (E4)
- Run duration, turns, total cost

### How the user verifies Phase 0

| Step | What you do | Needs | What you check |
|---|---|---|---|
| 1. Automated tests | Look at CI on the pull request, or run `pnpm install && pnpm test` | Node only | All green; no API cost (FakeRunner) |
| 2. Offline demo | `pnpm demo`: builds a toy repo and replays a scripted agent, then prints `turtle log` / `show` / a fork | Node + git | The tree, summaries, diffs and fork look right; no API key needed |
| 3. Real runs | Install turtle, run 5 real tasks on a repo you know (`turtle run ...`), answer at least one `need_decision`, fork at least once, press Ctrl-C once mid-run | Node, git, Docker, API key | You can tell what happened and why from `turtle log` / `show` without reading the transcript |
| 4. Consistency | `turtle doctor` after the Ctrl-C run | — | No errors (E6) |
| 5. Numbers | `turtle stats --criteria` | — | E1–E5 pass; review E2 (checkpoint count) and E4 (overhead) together with your own impression |

Step 3 is the real test: Phase 0 passes only if reading the tree is clearly better than scrolling the chat. Your feedback there drives the rule tuning in M8.

---

## 17. Milestones

| # | Deliverable |
|---|---|
| M0 | Repo scaffold: pnpm workspace, tsconfig, Biome, vitest, CI |
| M1 | `core/git`: snapshot, materialize, refs, blobs, diff + tests |
| M2 | `core/db`: schema, migrations, repositories, reconciler + tests |
| M3 | `protocol` + FakeRunner + orchestrator loop (micro snapshots, declared checkpoints, rules) + tests |
| M4 | `runner-claude` in `none` mode: SDK, hooks, MCP tools; VERIFY items in §10 and §13 |
| M5 | Summarizer + Stop / interrupt checkpoints |
| M6 | CLI: init, run (incl. continue/fork), status, log, show, checkout, tag, export, stop, gc, doctor, stats; `pnpm demo` |
| M7 | Docker sandbox + base image |
| M8 | Dogfooding against the exit criteria; tune rules |

---

## 18. Known Limitations and Open Questions

| Topic | Note |
|---|---|
| No `.git` in workspace | Build scripts that call git fail. Mitigation later: a read-only `GIT_DIR` pointing to a scratch repo |
| Ignored files across forks | `node_modules`, build outputs are rebuilt via `setupCommand`; secrets via `copyIgnored` |
| Claude subagents (Task tool) | Run in the same workspace; recorded as events on the same branch, not as turtle branches |
| No mid-run human input | `need_decision` / `blocked` end the run; Phase 2 adds inject |
| Session file coupling | Relies on `CLAUDE_CONFIG_DIR` and cwd-based session lookup (VERIFY, §10) |
| Concurrency | Multiple `turtle run` processes, no daemon; Phase 1 adds the daemon |
| Decided: root snapshot | Includes uncommitted changes by default; `--from-head` opts out |
| Decided: package manager | pnpm for development only; users install one npm package |
