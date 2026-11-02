# turtle — Phase 1 Spec: Web UI

> Status: implemented. Builds on [phase0-spec.md](./phase0-spec.md); architecture in [architecture.md](./architecture.md). How to test it by hand: [tutorial.md](./tutorial.md).

## 1. Goal

Phase 0 recorded agent work as a tree of checkpoints, but the only way to see it was the CLI. Phase 1 answers the question from the phased plan: **can a human keep up with the AI?** It gives the human a live, visual picture of what the agents are doing and what is waiting for them.

### Scope

| In Phase 1 | Later |
|---|---|
| `turtle ui`: a local web app per repository | Multi-repo / team server (Phase 3+) |
| Attention queue: questions, blocked agents, failed runs, failing tests, budget warnings | Notifications outside the browser tab |
| Live tree: semantic checkpoints by default, every tool call ("steps") on demand | Collapsing path segments, search, virtualized rendering |
| Node detail: summary, claimed-vs-verified facts, diff, steps that led to it, artifacts | Side-by-side compare view (Phase 3) |
| Live branch view: the agent's conversation as it happens | Token-level streaming |
| Actions that already existed in the Phase 0 CLI: new run, continue/answer, fork, stop, tag, export | redirect, human_edit, merge, explore (Phases 2–3) |

**Decision (D13):** the plan called Phase 1 "read-only", but the CLI already had run/continue/fork/stop, so the UI exposes them. Testing the whole loop from one screen is the point of the phase. Phase 2's new semantics (redirect, human_edit) remain out of scope.

## 2. User workflow

```bash
cd my-repo
turtle ui                    # opens http://127.0.0.1:4317
```

- The left column is the **attention queue** ("Needs you"), the running agents, and all branches.
- The center is the **tree**, newest first. Each lane is a branch; forks curve off their parent node.
- Clicking a node opens its **detail panel**. Clicking a branch chip or a running agent opens the **live branch view**.
- **New run** starts an agent on a new branch. In a node panel, **Answer/Continue** resumes the branch head, and **Fork from here** starts a new branch from any node.
- Runs started with `turtle run` in a terminal appear live too, and the UI can stop them.

## 3. Process architecture

```
browser ──HTTP (JSON) / SSE──▶ turtle ui (Node, 127.0.0.1)
                                 ├─ StateBuilder: reads SQLite
                                 ├─ RunSession × N   (runs started from the browser)
                                 ├─ poll loop 250 ms: db.changeToken() → SSE "change"
                                 └─ reconcile every 5 s
turtle run (other terminals) ──▶ own process, own RunSession, same SQLite + git
```

- **`turtle ui` is also an orchestrator.** Runs started from the browser are `RunSession`s inside the server process, the same code as `turtle run`. When the server stops, it interrupts them, and each run's work is kept as a `killed` checkpoint.
- **SQLite is the bus.** The server never assumes it is the only writer. Every 250 ms it reads `PRAGMA data_version` (which changes when *another* connection commits) plus its own `total_changes()`. On any change it pushes a bare `change` event over Server-Sent Events, and the client refetches. This picks up CLI runs in other processes with no extra IPC.
- **SSE, not WebSocket (D12).** Commands are plain HTTP POSTs; the server only needs to push. SSE reconnects by itself and needs no dependency.

### 3.1 Reconcile race (fixed in Phase 1)

`reconcile()` imports commits that have a `Turtle-Node` trailer but no DB row. A running session writes the commit and moves the ref *before* inserting the row. A reconcile in that window would import the node itself, and the session's insert would then fail on the primary key. Phase 0 could already hit this (`turtle status` during a run). The UI's periodic reconcile would hit it routinely. Two fixes:

1. `reconcile` skips branch refs whose branch has an agent in `running`/`starting` with a live pid. The live writer owns them, and once the process is dead the commits are imported as before.
2. A new run inserts its branch and root rows *before* creating the ref.

### 3.2 Launch failures

If the launcher throws (for example, the Docker image is missing), `RunSession.start` now marks the agent and branch `failed` and records a `run_end` event with the error. In the CLI, the process exit used to cover this, through reconcile. A long-lived server would otherwise show a branch stuck in `running`. The error reaches the attention queue ("Run failed" plus the message).

## 4. Shared operations (`core/src/ops.ts`)

Tag, export, and stop moved from the CLI into core so the CLI and the server share them. They throw `OpsError` for user-fixable problems; the server maps it to HTTP 400.

| Function | Notes |
|---|---|
| `checkpointOf(db, node)` | The node, or its nearest non-micro ancestor |
| `diffBaseOf(db, node)` | Previous checkpoint for semantic nodes, parent otherwise |
| `stepNodeIds(db, node)` | The node plus the micro snapshots just before it; their messages are the node's "steps" |
| `tagNode`, `exportNode` | As in Phase 0 (`turtle tag`, `turtle export`) |
| `requestStop(store, db, branch)` | See §4.1 |

### 4.1 Stopping a run owned by another process

| Owner | Marker file | How stop reaches it |
|---|---|---|
| `turtle run` | `.git/turtle/run/<agent>.pid` | `SIGINT` to that pid (as in Phase 0) |
| `turtle ui` | `.git/turtle/run/<agent>.ui` | An event `stop_request` in SQLite; the server's poll loop interrupts the session |
| Neither | — | Reported as "no owning process"; `turtle doctor` cleans up |

The UI's own stop button interrupts its sessions directly. A second press kills the runner, like a second Ctrl-C. The Phase 0 fallback of signalling `agents.pid` was removed: for UI-owned runs that pid is the server itself.

## 5. HTTP API

All JSON. Types are in `packages/server/src/api.ts`, which the web client imports directly.

| Method & path | Returns |
|---|---|
| `GET /api/state[?micro]` | `StateResponse`: repo, defaults, branches (with `checkpointHeadId`, `pendingSteps`, `costUsd`, `lastError`), agents (with `costUsd`, `maxBudgetUsd`, `ownedByUi`), nodes (`displayParent`, `hiddenSteps`), snapshots, attention, totals |
| `GET /api/events` | SSE: `hello`, `change`, `log` (run warnings/errors) |
| `GET /api/nodes/:id` | `NodeDetailResponse`: node, branch, agent, diff base, children, artifacts, snapshot names, steps, `canContinue` |
| `GET /api/nodes/:id/diff[?base=checkpoint\|parent\|<node>]` | Unified diff (capped at 2 MB) |
| `GET /api/agents/:id/transcript[?after=<seq>]` | Display items since `seq` (tool inputs ≤ 2 kB, results ≤ 4 kB) |
| `GET /api/artifacts/:id` | The blob, served with `Content-Security-Policy: sandbox` |
| `POST /api/runs` | `{prompt, from?, fork?, fromHead?, sandbox?, model?, budget?, name?}` → `{agentId, branchId, mode}` |
| `POST /api/branches/:id/stop` | Per-agent results (`direct`, `signal`, `request`) |
| `POST /api/nodes/:id/tag` | `{name}` |
| `POST /api/nodes/:id/export` | `{branch, message?}` |

Everything else is the static client; unknown paths fall back to `index.html`.

**Attention rules.**

| Item | Raised when |
|---|---|
| `need_decision` / `blocked` | The branch is idle and its latest checkpoint has that status |
| `failed` | The branch failed; the item carries the last run's error |
| `tests_failing` | A running branch's head reports failing tests |
| `budget` | A running agent's cost estimate reaches 80% of its budget |

## 6. Security model

The server binds to `127.0.0.1` only and runs agents with the user's credentials, so a web page from anywhere else must not be able to drive it.

- **Host header check.** Only `127.0.0.1`, `localhost` or `[::1]` with the right port are accepted. This defeats DNS rebinding.
- **Writes need `x-turtle: 1` and `application/json`.** Both force a CORS preflight, which the server never approves. Cross-origin `Origin` headers are rejected as well.
- **Artifacts are sandboxed.** Agent-written HTML is served with a CSP `sandbox` in an opaque origin, so its scripts cannot call the API.
- **Path traversal.** Static paths are normalized and confined to the client directory.
- **Limits.** Request bodies are capped at 1 MB.

There is no login: anyone with a shell on the machine can already run turtle. Binding to other interfaces is not supported in Phase 1.

## 7. Web client (`packages/web`)

React 19 + Vite, with no UI library. The build (`dist/`) is served by `turtle ui`.

- **Tree layout** (`layout.ts`) is git-graph style. There is one row per node, newest first. Rows are ordered by time but forced topological, so a parent always sits below its children. Each branch gets a lane, reserved from its fork point to its last row (to the top while the branch is running or idle). Lanes are reused greedily, like interval-graph colouring. Fork edges curve into the parent's lane.
- **Node marks.** Status gives the colour. Shape gives the kind: a square for root, a dot for micro, and a circle for semantic. A filled circle means declared by the agent; a hollow one means an automatic checkpoint (UI principle: "what the AI claims is shown separately"). The selected node gets a ring; a running branch head pulses.
- **Steps.** Micro snapshots are folded into "N steps" on the next checkpoint. "Show steps" lists every tool call.
- **Node panel.**
  - Facts: source (declared / automatic plus the rule that fired / human), changes since the diff base, tests, cost and tokens, the prompt.
  - Composer: Answer/Continue on a branch head, otherwise Fork.
  - Tabs: Changes (diff viewer), Steps (the messages that led to this node), Artifacts, Save & export.
- **Branch panel.** Every run on the branch, oldest first. Each run shows the human prompt, then the agent's text, collapsible tool calls (with results), and a checkpoint divider after the last message of each checkpoint. Transcripts are fetched incrementally (`after=seq`) on every `change`.
- **Selection** lives in the URL hash (`#/node/<id>`, `#/branch/<id>`). "Show steps" and dismissed attention items stay in `localStorage`.
- **Display.** Light and dark themes follow the OS. The layout works down to phone width.

## 8. Packages and build

| Package | Phase 1 change |
|---|---|
| `core` | `ops.ts`, `TurtleDb.getArtifact` / `changeToken`, reconcile and launch-failure fixes, `maxBudgetUsd` in `run_start` events |
| `server` (new) | `startServer`, `StateBuilder`, transcript flattening, `demoLauncher` |
| `web` (new) | The client; `pnpm --filter @turtle/web dev` proxies `/api` to `turtle ui --port 4317` |
| `cli` | `turtle ui [--port] [--no-open] [--demo-agent]`; credential hint in `run`, `ui`, `doctor` |

`pnpm build` runs `tsc -b`, then `vite build`.

**Credentials.** Each agent gets its own `CLAUDE_CONFIG_DIR`, so a `claude` login stored in the macOS Keychain is not visible to it. Credentials must come from the environment: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, for subscriptions) or `ANTHROPIC_API_KEY`. `turtle run`, `turtle ui` and `turtle doctor` warn when neither is set. The Haiku summarizer for automatic checkpoints needs an API key. With only an OAuth token, automatic checkpoints get plain summaries.

## 9. Testing

| Layer | What |
|---|---|
| `server/test/server.test.ts` | Runs through the API with the FakeRunner: new → need_decision → continue → fork. Also: tree folding, attention, node detail, diff, transcript paging, artifact CSP, stop (direct and via `stop_request` from another DB connection), SSE change on a foreign write, tag/export errors, launch failure in the attention queue, Host/Origin/header checks, path traversal |
| `web/test/web.test.ts` | Lane layout, lane reuse, topological order on timestamp ties, diff parsing, id shortening, formatting |
| `core/test/reconcile.test.ts` | Live writers are skipped until their process is gone |
| `pnpm demo:ui` | The Phase 0 demo tree plus `turtle ui --demo-agent`: scripted agents that ask questions, get blocked or finish depending on the prompt, with no credentials |
| `pnpm ui:smoke` | Headless Chromium drives the demo end to end (attention → detail → new run → question → answer → fork → stop → steps → dark → phone) and saves screenshots; fails on console errors or horizontal scroll on a phone |

## 10. Acceptance (manual, see the tutorial)

| # | Check |
|---|---|
| U1 | A question from the agent reaches "Needs you" within about 1 s of the checkpoint, and answering it from the browser continues the same agent with its memory |
| U2 | While an agent runs, its tool calls appear in the branch view without reloading, and new checkpoints appear in the tree |
| U3 | A fork from a mid-run checkpoint starts a new lane; the forked agent remembers the conversation up to that point |
| U4 | Stop works for browser-started runs and for `turtle run` in another terminal; the work is kept as a `stopped` checkpoint |
| U5 | From a node, the diff and the steps explain what changed and why, without the CLI |
| U6 | Subjective: with two agents running, you can tell at a glance what each is doing and what needs you |

## 11. Limitations and scale-up notes

- **Full state refetch.** Every `change` refetches the whole state, which is fine for hundreds of nodes. Thousands need delta sync (events since `seq`) and a virtualized tree; see architecture §13.4.
- **Polling.** One `data_version` query every 250 ms is cheap. Event tables are read in full per state build, and should become indexed incremental reads later.
- **Runs die with the server.** Browser-started runs live in the server process: stopping `turtle ui` interrupts them. Long unattended runs should use `turtle run` (or a future daemon).
- **Not token streaming.** The live view updates per SDK message.
- **One repository per server.** Run one `turtle ui` per repo, on different ports.
- **Not yet verified on macOS.** The tutorial is the macOS acceptance run.
