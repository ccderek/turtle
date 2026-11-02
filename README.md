# turtle

A human–AI interface and version-control layer for AI coding agents: every step an agent takes becomes a checkpoint in a tree you can inspect, fork, and steer.

Status: Phase 0 (recording layer) implemented — CLI only, no web UI yet. Design: [docs/architecture.md](docs/architecture.md), [docs/phase0-spec.md](docs/phase0-spec.md).

## Try it

Requires Node.js ≥ 22, pnpm, git ≥ 2.40, and (for the default sandbox) Docker. Agents need Claude credentials (`ANTHROPIC_API_KEY`, or a Claude Code login).

```bash
pnpm install
pnpm demo                     # offline: builds a forked tree with a scripted agent, no API key
pnpm build
pnpm docker:build             # runner image for --sandbox docker
```

In any git repository:

```bash
alias turtle="node /path/to/turtle/packages/cli/dist/main.js"
turtle init                                   # creates turtle.config.json
turtle run "Add a --json flag to the exporter"
turtle status                                 # what is running, what waits for you
turtle run --from <node> "Yes, pretty-print"  # answer a question / continue a branch
turtle run --from <node> --fork "Try another way"
turtle log                                    # the tree (--all adds micro snapshots)
turtle show <node> --diff --transcript
turtle export <node> --branch feat/json       # one normal git commit on your HEAD
turtle doctor && turtle stats --criteria
```

Press Ctrl-C once to interrupt an agent (its work is kept as a `killed` checkpoint), twice to kill it.

## Development

```bash
pnpm test             # vitest (no API key needed: a scripted FakeRunner speaks the real protocol)
pnpm lint             # biome
pnpm typecheck
pnpm bench:snapshot   # snapshot latency on a synthetic 10k-file repo
pnpm e2e              # real API run with Haiku: new → need_decision → continue → fork (~$0.02)
pnpm docker:smoke     # docker sandbox mechanics, no API calls
```

| Package | Purpose |
|---|---|
| `packages/protocol` | Orchestrator ↔ runner message types and JSONL framing |
| `packages/core` | Git store, SQLite, run orchestration, checkpoint rules, summarizers, sandboxes |
| `packages/runner-claude` | `turtle-runner`: Claude Agent SDK runner (runs inside the sandbox) |
| `packages/cli` | The `turtle` command |
