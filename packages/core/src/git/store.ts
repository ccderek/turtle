import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitError, git, runGit } from "./exec.js";
import { formatNodeMessage, type NodeMessage, parseNodeMessage } from "./message.js";

export const BRANCH_REF_PREFIX = "refs/turtle/branches/";
export const SNAPSHOT_REF_PREFIX = "refs/turtle/snapshots/";

export interface Identity {
  name: string;
  email: string;
}

export const AGENT_IDENTITY: Identity = { name: "turtle-agent", email: "agent@turtle.invalid" };

export interface DiffStat {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

export interface SnapshotInput {
  /** Directory whose content is snapshotted. */
  workTree: string;
  /** Per-branch index file (kept between snapshots as a stat cache). */
  indexFile: string;
  /** Parent commit; omit for a commit without parents. */
  parent?: { commit: string; tree: string };
  message: NodeMessage | string;
  identity: Identity;
  /**
   * When false and the tree equals the parent's tree, nothing is written and
   * `snapshot` returns null.
   */
  allowUnchanged: boolean;
  /** Move this ref to the new commit, failing if it no longer points at `expectedOld`. */
  ref?: { name: string; expectedOld: string | null };
}

export interface SnapshotResult {
  commit: string;
  tree: string;
  parentTree: string;
  stat: DiffStat;
  changed: boolean;
  durationMs: number;
}

export class RefConflictError extends Error {
  constructor(
    readonly ref: string,
    readonly expectedOld: string | null,
    cause: unknown,
  ) {
    super(`ref ${ref} moved: expected ${expectedOld ?? "(absent)"}`, { cause });
    this.name = "RefConflictError";
  }
}

/**
 * Low-level access to a repository's object store and refs for turtle.
 * Works on any directory as a work tree via GIT_WORK_TREE + a separate index file,
 * so workspaces never contain a .git entry.
 */
export class GitStore {
  private emptyTreeSha: string | undefined;

  private constructor(
    /** Git dir of the worktree turtle was opened from (holds its HEAD). */
    readonly gitDir: string,
    /** Shared git dir (objects, refs, turtle state). */
    readonly commonDir: string,
    /** Top level of the user's working tree, or null for a bare repo. */
    readonly topLevel: string | null,
  ) {}

  static async open(path: string): Promise<GitStore> {
    const cwd = resolve(path);
    const out = await git(
      ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
      { cwd },
    );
    const [gitDir, commonDir] = out.split("\n");
    if (!gitDir || !commonDir) throw new Error(`not a git repository: ${cwd}`);
    let topLevel: string | null = null;
    try {
      topLevel = await git(["rev-parse", "--show-toplevel"], { cwd });
    } catch {
      topLevel = null;
    }
    return new GitStore(gitDir, commonDir, topLevel || null);
  }

  /** Directory for turtle's own state (DB, index files, logs). */
  get turtleDir(): string {
    return join(this.commonDir, "turtle");
  }

  indexFileFor(branchId: string): string {
    return join(this.turtleDir, "index", branchId);
  }

  /** Run git against the shared object store. */
  run(
    args: readonly string[],
    extra: { workTree?: string; indexFile?: string; input?: string } = {},
  ) {
    return git(args, { gitDir: this.commonDir, ...extra });
  }

  async emptyTree(): Promise<string> {
    this.emptyTreeSha ??= await this.run(["hash-object", "-t", "tree", "-w", "--stdin"], {
      input: "",
    });
    return this.emptyTreeSha;
  }

  // ---------------------------------------------------------------- refs

  async readRef(ref: string): Promise<string | null> {
    const { stdout, exitCode } = await runGit(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      {
        gitDir: this.commonDir,
        okCodes: [0, 1],
      },
    );
    return exitCode === 0 ? stdout.toString("utf8").trim() : null;
  }

  /** Compare-and-swap update. `expectedOld = null` requires the ref to be absent. */
  async updateRef(ref: string, newSha: string, expectedOld: string | null): Promise<void> {
    try {
      await this.run(["update-ref", ref, newSha, expectedOld ?? ""]);
    } catch (err) {
      if (err instanceof GitError) throw new RefConflictError(ref, expectedOld, err);
      throw err;
    }
  }

  async deleteRef(ref: string, expectedOld?: string): Promise<void> {
    await this.run(
      expectedOld ? ["update-ref", "-d", ref, expectedOld] : ["update-ref", "-d", ref],
    );
  }

  async listRefs(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const out = await this.run(["for-each-ref", "--format=%(objectname) %(refname)", prefix]);
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [sha = "", ref = ""] = line.split(" ");
      return { ref, sha };
    });
  }

  // ------------------------------------------------------------- objects

  async commitTree(
    tree: string,
    parents: readonly string[],
    message: string,
    identity: Identity,
  ): Promise<string> {
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
    const { stdout } = await runGit(args, {
      gitDir: this.commonDir,
      input: message,
      env: {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      },
    });
    return stdout.toString("utf8").trim();
  }

  async readCommit(sha: string): Promise<CommitInfo & { node: NodeMessage }> {
    const raw = (
      await runGit(["cat-file", "commit", sha], { gitDir: this.commonDir })
    ).stdout.toString("utf8");
    const headerEnd = raw.indexOf("\n\n");
    const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
    const message = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
    let tree = "";
    const parents: string[] = [];
    for (const line of header.split("\n")) {
      if (line.startsWith("tree ")) tree = line.slice(5);
      else if (line.startsWith("parent ")) parents.push(line.slice(7));
    }
    const resolved = await this.run(["rev-parse", "--verify", `${sha}^{commit}`]);
    return { sha: resolved, tree, parents, message, node: parseNodeMessage(message) };
  }

  /** Store a file's content as a blob; returns its sha. */
  async hashFile(path: string): Promise<string> {
    return this.run(["hash-object", "-w", "--no-filters", "--", path]);
  }

  async readBlob(sha: string): Promise<Buffer> {
    return (await runGit(["cat-file", "blob", sha], { gitDir: this.commonDir })).stdout;
  }

  // ---------------------------------------------------------------- diffs

  async diffStat(fromTree: string, toTree: string): Promise<DiffStat> {
    if (fromTree === toTree) return { filesChanged: 0, linesAdded: 0, linesDeleted: 0 };
    const { stdout } = await runGit(
      ["diff-tree", "-r", "--numstat", "-z", "--no-renames", fromTree, toTree],
      { gitDir: this.commonDir },
    );
    const stat: DiffStat = { filesChanged: 0, linesAdded: 0, linesDeleted: 0 };
    for (const record of stdout.toString("utf8").split("\0")) {
      const m = /^(-|\d+)\t(-|\d+)\t/.exec(record);
      if (!m) continue;
      stat.filesChanged++;
      if (m[1] !== "-") stat.linesAdded += Number(m[1]);
      if (m[2] !== "-") stat.linesDeleted += Number(m[2]);
    }
    return stat;
  }

  /** Unified diff between two trees, optionally limited to paths. */
  async diff(
    fromTree: string,
    toTree: string,
    paths: readonly string[] = [],
    opts: { prefix?: string } = {},
  ): Promise<string> {
    const args = ["diff-tree", "-r", "-p", "--no-renames", "--no-color"];
    if (opts.prefix) args.push(`--src-prefix=a/${opts.prefix}/`, `--dst-prefix=b/${opts.prefix}/`);
    args.push(fromTree, toTree);
    if (paths.length > 0) args.push("--", ...paths);
    const { stdout } = await runGit(args, { gitDir: this.commonDir });
    return stdout.toString("utf8");
  }

  // ------------------------------------------------------------ snapshots

  /** Stage everything in `workTree` (honoring .gitignore) into `indexFile` and write a tree. */
  async writeWorkTree(workTree: string, indexFile: string): Promise<string> {
    await mkdir(join(indexFile, ".."), { recursive: true });
    const opts = { workTree, indexFile };
    await this.run(["add", "-A", "--ignore-errors", "--", "."], opts);
    return this.run(["write-tree"], opts);
  }

  async snapshot(input: SnapshotInput): Promise<SnapshotResult | null> {
    const started = performance.now();
    const tree = await this.writeWorkTree(input.workTree, input.indexFile);
    const parentTree = input.parent?.tree ?? (await this.emptyTree());
    const changed = tree !== parentTree;
    if (!changed && !input.allowUnchanged) return null;

    const message =
      typeof input.message === "string" ? input.message : formatNodeMessage(input.message);
    const commit = await this.commitTree(
      tree,
      input.parent ? [input.parent.commit] : [],
      message,
      input.identity,
    );
    if (input.ref) await this.updateRef(input.ref.name, commit, input.ref.expectedOld);
    const stat = await this.diffStat(parentTree, tree);
    return { commit, tree, parentTree, stat, changed, durationMs: performance.now() - started };
  }

  /**
   * Snapshot the user's working tree (uncommitted and untracked changes included,
   * .gitignore honored) without touching their index or branches. The commit's parent
   * is HEAD (none for an unborn branch). With `fromHead`, returns HEAD's tree unchanged.
   */
  async snapshotWorkingCopy(opts: {
    indexFile: string;
    message: NodeMessage | string;
    identity: Identity;
    fromHead?: boolean;
  }): Promise<{ commit: string; tree: string; head: string | null; dirty: boolean }> {
    if (!this.topLevel) throw new Error("repository has no working tree");
    const head = await this.resolveHead();
    const headTree = head ? (await this.readCommit(head)).tree : await this.emptyTree();
    let tree = headTree;
    if (!opts.fromHead) {
      await rm(opts.indexFile, { force: true });
      await mkdir(join(opts.indexFile, ".."), { recursive: true });
      const env = { workTree: this.topLevel, indexFile: opts.indexFile };
      if (head) await git(["read-tree", head], { gitDir: this.gitDir, ...env });
      await git(["add", "-A", "--ignore-errors", "--", "."], { gitDir: this.gitDir, ...env });
      tree = await git(["write-tree"], { gitDir: this.gitDir, ...env });
      await rm(opts.indexFile, { force: true });
    }
    const message =
      typeof opts.message === "string" ? opts.message : formatNodeMessage(opts.message);
    const commit = await this.commitTree(tree, head ? [head] : [], message, opts.identity);
    return { commit, tree, head, dirty: tree !== headTree };
  }

  /** HEAD of the worktree turtle was opened from, or null when the branch is unborn. */
  async resolveHead(): Promise<string | null> {
    const { stdout, exitCode } = await runGit(
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      {
        gitDir: this.gitDir,
        okCodes: [0, 1],
      },
    );
    return exitCode === 0 ? stdout.toString("utf8").trim() : null;
  }

  /**
   * Write a commit's tree into an empty directory and prime `indexFile` for it,
   * so the next snapshot of that directory is incremental.
   */
  async materialize(commit: string, workTree: string, indexFile: string): Promise<void> {
    await mkdir(workTree, { recursive: true });
    const entries = await readdir(workTree);
    if (entries.length > 0) throw new Error(`workspace is not empty: ${workTree}`);
    await mkdir(join(indexFile, ".."), { recursive: true });
    await rm(indexFile, { force: true });
    const opts = { workTree, indexFile };
    await this.run(["read-tree", commit], opts);
    await this.run(["checkout-index", "-a", "-f"], opts);
    // Refresh stat info so the first snapshot does not rehash every file.
    await this.run(["update-index", "-q", "--refresh"], opts).catch(() => undefined);
  }

  /** Read the user's git identity, falling back to a generic one. */
  async userIdentity(): Promise<Identity> {
    const get = async (key: string) => {
      const { stdout, exitCode } = await runGit(["config", "--get", key], {
        gitDir: this.gitDir,
        okCodes: [0, 1],
      });
      return exitCode === 0 ? stdout.toString("utf8").trim() : "";
    };
    const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
    return { name: name || "turtle-user", email: email || "user@turtle.invalid" };
  }
}
