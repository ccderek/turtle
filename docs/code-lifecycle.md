# Where the code lives: the lifecycle of an agent's work

A reference for how turtle stores the code its agents write, how to find it with plain git, and how it gets back into your branches. It describes the current implementation (Phases 0–2).

## The short version

Every step an agent takes is a **git commit in your repository**, but not on any of your branches. turtle keeps them under `refs/turtle/branches/…`, next to your `refs/heads/…`, in the same `.git`. Plain `git log` follows only your current branch, so it does not show them. Nothing reaches your branches or your working directory until you export a checkpoint.

```
your repository
│
├─ refs/heads/main ─────────────── your code (what `git log` shows)
│                          │
│   ① a task starts: turtle snapshots your files as they are (uncommitted changes included)
│                          ▼
├─ refs/turtle/branches/<branch id>
│      start ─ micro ─ micro ─ ◆checkpoint ─ micro ─ ◆checkpoint
│      ② the agent works in its own copy (~/.turtle/workspaces/…); every file change is a commit
│      ③ continue, answer, tell, pause, resume: the same branch grows
│                               │
│      ④ start from a checkpoint (retry, new task from here, replay)
│                               └─ refs/turtle/branches/<new branch id> ─ …
│
└─ ⑤ you pick a result: turtle export <checkpoint> --branch feat/x
      → refs/heads/feat/x: one ordinary commit → git push → pull request
```

## What is stored where

| What | Where | Notes |
|---|---|---|
| Your code | `refs/heads/*`, your working directory | turtle never writes here, except `turtle export` (a new branch) and `turtle checkout` (a directory you name) |
| Every step of every run | Commits on `refs/turtle/branches/<branch id>` in your repository | One branch per line of work: a new task, or a start from a checkpoint. Kept for good; abandoning or dropping a task does not delete them |
| Named snapshots | `refs/turtle/snapshots/<name>` | Created by **Save & export → Save snapshot** (`turtle tag`) |
| The agent's working copy | `~/.turtle/workspaces/<repo id>/<branch id>/` | A plain directory without `.git`. Scratch space: `turtle gc` removes those of finished branches, and a later run re-creates one from the commits |
| Run records | `.git/turtle/turtle.db` (SQLite) in your repository | Branches, nodes, agents, transcripts, events. A cache of the refs for the tree; the only copy of the transcripts |
| The task graph | `~/.turtle/projects/<name>/`, its own git repository | `turtle-project.json`; the operation log on `refs/turtle/ops/<member>/<replica>`; `.git/turtle/project.db` (cache); `.git/turtle/gate/` (audits, export judgments) |
| Which project a repository belongs to | `.git/turtle/project` in your repository | A one-line pointer, written by `turtle init` |

Multi-source projects: each source repository has its own `refs/turtle/branches/…`; a task's workspace is a directory with one subdirectory per source, and companion commits carry a `Turtle-Checkpoint: <primary node id>` trailer.

## The lifecycle, step by step

1. **Start.** When a task starts (or `turtle run`), turtle commits a snapshot of your files as they are, uncommitted changes included, as the branch's first commit (the *start*, a square in the tree). Its parent is your HEAD at that moment. The agent's copy is materialized from it in `~/.turtle/workspaces/…`.
2. **Micro snapshots.** After every tool call that changes files, turtle commits the copy (`micro: after Edit`). These are the fine-grained steps; the tree hides them unless *Show steps* is on.
3. **Checkpoints.** When the agent calls the checkpoint tool, or a fallback rule fires, or the run ends, turtle commits a *semantic* node: a summary like a commit message, a status (`progress`, `done`, `need_decision`, `blocked`, `killed`, `failed`) and a conversation resume point. These are the nodes of the tree and the evidence links of tasks.
4. **Continue.** Answering a question, telling a running agent, resuming a paused task: the same branch grows, in the same copy.
5. **Fork.** Retrying, "new task from here", a recipe replay, or `turtle run --from <node> --fork`: a new branch starts at that checkpoint, in a fresh copy, with the conversation forked at that point (or a summary of it when it cannot be resumed).
6. **Export.** `turtle export <node> --branch feat/x` (or **Save & export → Export as a git branch**) creates `refs/heads/feat/x` with **one** ordinary commit holding that node's files. Its parent is the HEAD the run started from, and its message lists the checkpoints on the way. From there it is plain git: merge it, rebase it, push it.
7. **Clean up.** `turtle gc` removes the working copies of finished branches. The commits stay.

Checks and recipes do not change this: checks only read the agent's copy, and a recipe replay is a branch like any other, whose first run happens to be the recipe instead of an agent.

## Seeing it with plain git

In your repository:

```bash
git for-each-ref refs/turtle/branches            # every line of agent work
git log --oneline refs/turtle/branches/<id>      # one branch: starts, micro snapshots, checkpoints
git log --all --oneline --graph                  # your branches and turtle's together
git show <commit>                                 # one step: its diff and its Turtle-* trailers
git ls-tree -r --name-only <commit>               # the files at that step
```

Each turtle commit ends with trailers that say what it is:

```
Turtle-Node: <node id>
Turtle-Kind: semantic | micro | root
Turtle-Status: done
Turtle-Branch: <branch id>
Turtle-Agent: <agent id>
Turtle-Summary-Source: agent_declared | rule_auto | ...
Turtle-Trigger: declared | stop | rule:maxToolCalls | ...
```

`git log` showing nothing (or only your own commits) is expected: the agent's work is on `refs/turtle/branches/…` until you export it. A repository with no commit of its own works too; the first start then has no parent.

## Working with GitHub

- **Before:** `git pull` as usual. New tasks start from your files at that moment, so the agents see the latest code.
- **After:** export the checkpoint you want as a branch, then `git push -u origin feat/x` and open a pull request. Reviewers see one ordinary commit, not every agent step.
- **The agent history stays local.** `git push` sends branches, not `refs/turtle/*`. To back it up: `git push origin 'refs/turtle/*:refs/turtle/*'`. Another machine or person picking up that history (and the task graph) is Phase 4 (sync through a git remote); today that push is a backup only.
- **The task graph** lives in its own repository (`~/.turtle/projects/<name>`) and is not pushed anywhere unless you do it yourself.

## Explaining it to a user in one paragraph

turtle never edits your branches. Each agent works in its own copy, and every step it takes is saved as a git commit in your repository, in a drawer next to your branches (`refs/turtle`). That is why you can rewind to any step, try another way from the middle, and see exactly what changed. When you like a result, you export it: it becomes an ordinary branch with one commit, which you merge or push like any other.
