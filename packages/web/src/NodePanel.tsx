import { useEffect, useMemo, useState } from "react";
import type { Ctx } from "./App.js";
import { type DiffResponse, get, type NodeDetailResponse, post } from "./api.js";
import { Composer } from "./Composer.js";
import { DiffView } from "./DiffView.js";
import { ago, firstLine, money, restLines, STATUS_LABEL, statusTone } from "./format.js";
import { Transcript } from "./Transcript.js";

type Tab = "changes" | "steps" | "artifacts" | "more";

const TRIGGER_LABEL: Record<string, string> = {
  maxToolCalls: "many tool calls since the last checkpoint",
  maxMinutes: "time since the last checkpoint",
  maxChangedLines: "many changed lines",
  maxChangedFiles: "many changed files",
  testFlip: "test result changed",
  stop: "the agent stopped",
  interrupt: "you stopped the agent",
  crash: "the run crashed",
};

export function NodePanel({
  ctx,
  nodeId,
  compose,
}: {
  ctx: Ctx;
  nodeId: string;
  compose: boolean;
}) {
  const { short, select, version, toast } = ctx;
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [composeMode, setComposeMode] = useState<"continue" | "fork">("continue");

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    const ac = new AbortController();
    get<NodeDetailResponse>(`/api/nodes/${nodeId}`, ac.signal)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => ac.abort();
  }, [nodeId, version]);

  useEffect(() => {
    const ac = new AbortController();
    get<DiffResponse>(`/api/nodes/${nodeId}/diff`, ac.signal)
      .then(setDiff)
      .catch(() => {});
    return () => ac.abort();
  }, [nodeId]);

  useEffect(() => {
    if (detail && !detail.canContinue) setComposeMode("fork");
  }, [detail]);

  const nodes = useMemo(() => new Map(ctx.state.nodes.map((n) => [n.id, n])), [ctx.state.nodes]);

  if (error)
    return (
      <PanelShell onClose={() => select(null)} title="Node">
        {<p className="bad pad">{error}</p>}
      </PanelShell>
    );
  if (!detail)
    return (
      <PanelShell onClose={() => select(null)} title="Node">
        <p className="muted pad">Loading…</p>
      </PanelShell>
    );

  const { node: n, branch, agent, base } = detail;
  const title = n.kind === "root" ? "Starting point" : firstLine(n.summary) || "(no summary)";
  const body = n.kind === "root" ? n.summary?.replace(/^root: /, "") : restLines(n.summary);
  const running = branch?.status === "running";
  const source =
    n.kind === "root"
      ? "Snapshot of your files when the run started"
      : n.kind === "micro"
        ? "Automatic snapshot after one tool call"
        : n.summarySource === "agent_declared"
          ? "Declared by the agent"
          : n.summarySource === "rule_auto"
            ? `Automatic checkpoint: ${TRIGGER_LABEL[n.trigger ?? ""] ?? n.trigger ?? "rule"} (summary written by turtle)`
            : n.summarySource === "human"
              ? "Written by you"
              : "Imported from git";

  const tag = async (form: HTMLFormElement) => {
    const name = new FormData(form).get("name")?.toString().trim();
    if (!name) return;
    try {
      await post(`/api/nodes/${n.id}/tag`, { name });
      toast(`Snapshot "${name}" saved`, "ok");
      form.reset();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };
  const exportNode = async (form: HTMLFormElement) => {
    const branchName = new FormData(form).get("branch")?.toString().trim();
    if (!branchName) return;
    try {
      const r = await post<{ branch: string; commit: string; includesUncommitted: boolean }>(
        `/api/nodes/${n.id}/export`,
        { branch: branchName },
      );
      toast(
        `Created git branch ${r.branch} (${r.commit.slice(0, 8)})${r.includesUncommitted ? " — includes your uncommitted changes" : ""}`,
        "ok",
      );
      form.reset();
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  return (
    <PanelShell
      onClose={() => select(null)}
      title={
        <>
          <span className={`badge ${statusTone(n.status)}`}>
            {n.kind === "root" ? "root" : (STATUS_LABEL[n.status] ?? n.status)}
          </span>
          <span className="mono">{short(n.id)}</span>
          {branch && (
            <button
              type="button"
              className={`chip ${statusTone(branch.status)}`}
              onClick={() => select({ type: "branch", id: branch.id })}
            >
              {branch.name ?? short(branch.id)} · {STATUS_LABEL[branch.status] ?? branch.status}
            </button>
          )}
          <span className="muted small">{ago(n.createdAt)}</span>
        </>
      }
    >
      <div className="pad">
        <h2 className="node-title">{title}</h2>
        {body && <p className="node-body">{body}</p>}
        <dl className="facts">
          <dt>Source</dt>
          <dd>{source}</dd>
          <dt>Changes</dt>
          <dd>
            {n.filesChanged ?? 0} files <span className="add">+{n.linesAdded ?? 0}</span>{" "}
            <span className="del">−{n.linesDeleted ?? 0}</span>
            {base && (
              <span className="muted">
                {" "}
                since{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => select({ type: "node", id: base.id })}
                >
                  {short(base.id)}
                </button>{" "}
                (
                {base.kind === "root"
                  ? "start"
                  : base.kind === "semantic"
                    ? "previous checkpoint"
                    : base.kind}
                )
              </span>
            )}
          </dd>
          <dt>Tests</dt>
          <dd>
            {n.tests === "pass" ? (
              <span className="ok">✓ passing</span>
            ) : n.tests === "fail" ? (
              <span className="bad">✗ failing</span>
            ) : (
              <span className="muted">not run</span>
            )}
          </dd>
          {n.kind !== "root" && (
            <>
              <dt>Cost</dt>
              <dd>
                {money(n.costUsdEst)}{" "}
                <span className="muted small">
                  in {n.tokens.input.toLocaleString()} · out {n.tokens.output.toLocaleString()} ·
                  cache {n.tokens.cacheRead.toLocaleString()}
                </span>
              </dd>
            </>
          )}
          {agent && (
            <>
              <dt>Asked</dt>
              <dd className="quote">{firstLine(agent.prompt)}</dd>
            </>
          )}
          {detail.snapshots.length > 0 && (
            <>
              <dt>Snapshots</dt>
              <dd>
                {detail.snapshots.map((s) => (
                  <span key={s} className="badge snap">
                    ⚑ {s}
                  </span>
                ))}
              </dd>
            </>
          )}
          {detail.children.length > 0 && (
            <>
              <dt>Next</dt>
              <dd>
                {detail.children.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="link mono"
                    onClick={() => select({ type: "node", id: c.id })}
                  >
                    {short(c.id)}
                    {c.kind === "micro" ? "·" : ""}{" "}
                  </button>
                ))}
              </dd>
            </>
          )}
        </dl>

        <div className="compose-box">
          {running && branch?.headNodeId === n.id ? (
            <p className="muted small">
              This branch is running. Fork from here to try something else in parallel.
            </p>
          ) : null}
          <div className="seg" role="tablist">
            {detail.canContinue && (
              <button
                type="button"
                role="tab"
                aria-selected={composeMode === "continue"}
                className={composeMode === "continue" ? "on" : ""}
                onClick={() => setComposeMode("continue")}
              >
                {n.status === "need_decision" || n.status === "blocked" ? "Answer" : "Continue"}
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={composeMode === "fork"}
              className={composeMode === "fork" ? "on" : ""}
              onClick={() => setComposeMode("fork")}
            >
              Fork from here
            </button>
          </div>
          {composeMode === "continue" && detail.canContinue ? (
            <Composer
              key="continue"
              ctx={ctx}
              mode="continue"
              from={n.id}
              autoFocus={compose}
              placeholder={
                n.status === "need_decision"
                  ? "Your answer…"
                  : "What next? The same agent continues with its memory."
              }
              submitLabel={
                n.status === "need_decision" || n.status === "blocked" ? "Answer" : "Continue"
              }
            />
          ) : (
            <Composer
              key="fork"
              ctx={ctx}
              mode="fork"
              from={n.id}
              autoFocus={compose && !detail.canContinue}
              placeholder="A different direction from this point. A new agent starts on a new branch."
              submitLabel="Fork"
            />
          )}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(["changes", "steps", "artifacts", "more"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}
          >
            {t === "changes"
              ? "Changes"
              : t === "steps"
                ? `Steps (${detail.steps.filter((s) => s.kind === "tool_use").length})`
                : t === "artifacts"
                  ? `Artifacts (${detail.artifacts.length})`
                  : "Save & export"}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "changes" &&
          (diff ? (
            <>
              <p className="muted small pad-x">
                Compared with{" "}
                {diff.base
                  ? `${short(diff.base.id)} (${diff.base.kind === "semantic" ? "previous checkpoint" : diff.base.kind})`
                  : "an empty tree"}
              </p>
              <DiffView diff={diff.diff} truncated={diff.truncated} />
            </>
          ) : (
            <p className="muted pad">Loading diff…</p>
          ))}
        {tab === "steps" &&
          (detail.steps.length ? (
            <Transcript
              items={detail.steps}
              nodes={nodes}
              short={short}
              onSelectNode={(id) => select({ type: "node", id })}
            />
          ) : (
            <p className="muted pad">No recorded messages for this node.</p>
          ))}
        {tab === "artifacts" &&
          (detail.artifacts.length ? (
            <ul className="artifacts pad">
              {detail.artifacts.map((a) => (
                <li key={a.id}>
                  <a href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                    {a.label ?? a.path}
                  </a>{" "}
                  <span className="muted small">
                    {a.path} · {a.mime ?? "?"} · {a.size ?? 0} bytes
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted pad">The agent attached no artifacts to this checkpoint.</p>
          ))}
        {tab === "more" && (
          <div className="pad more">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void tag(e.currentTarget);
              }}
            >
              <label className="more-field">
                Save as snapshot{" "}
                <span className="muted small">(a named ref that is never garbage-collected)</span>
                <span className="inline">
                  <input name="name" placeholder="e.g. json-v1" pattern="[\w.\-]+" required />
                  <button type="submit">Save</button>
                </span>
              </label>
            </form>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void exportNode(e.currentTarget);
              }}
            >
              <label className="more-field">
                Export as git branch{" "}
                <span className="muted small">
                  (one commit with this node's files, on the run's HEAD)
                </span>
                <span className="inline">
                  <input name="branch" placeholder="e.g. feat/json" required />
                  <button type="submit">Export</button>
                </span>
              </label>
            </form>
            <p className="muted small">
              CLI: <code>turtle show {short(n.id)} --diff</code> ·{" "}
              <code>turtle checkout {short(n.id)}</code>
            </p>
          </div>
        )}
      </div>
    </PanelShell>
  );
}

export function PanelShell({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="panel-inner">
      <div className="panel-head">
        <div className="panel-title">{title}</div>
        <button type="button" className="icon" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="panel-scroll">{children}</div>
    </div>
  );
}
