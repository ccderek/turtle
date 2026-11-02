# turtle

A human–AI interface and version-control layer for AI coding agents: every step an agent takes becomes a checkpoint in a tree you can inspect, fork, and steer.

Status: Phase 0 (recording layer) in progress. See [docs/architecture.md](docs/architecture.md) and [docs/phase0-spec.md](docs/phase0-spec.md).

## Development

Requires Node.js ≥ 22, pnpm, and git ≥ 2.40.

```bash
pnpm install
pnpm build        # tsc -b
pnpm test         # vitest
pnpm lint         # biome
pnpm typecheck
pnpm bench:snapshot   # snapshot latency on a synthetic 10k-file repo
```

| Package | Purpose |
|---|---|
| `packages/protocol` | Orchestrator ↔ runner message types |
| `packages/core` | Git store, DB, checkpoint engine, run orchestration |
| `packages/runner-claude` | Claude Agent SDK runner (runs inside the sandbox) |
| `packages/cli` | The `turtle` command |
