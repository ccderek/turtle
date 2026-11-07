import { useEffect, useMemo, useState } from "react";
import { type Concept, get, type OutputContentResponse } from "../api.js";
import { ago, firstLine, STATUS_LABEL, statusTone } from "../format.js";
import { Transcript } from "../Transcript.js";
import { useAgentLogs } from "../useAgentLogs.js";
import type { GraphCtx } from "./TasksView.js";

/** Branch ids of a task's runs that the Code view (the primary source) knows. */
function taskBranchIds(ctx: GraphCtx, c: Concept): Set<string> {
  const known = new Set(ctx.code.branches.map((b) => b.id));
  return new Set((c.branches ?? []).map((b) => b.branch).filter((id) => known.has(id)));
}

/** Every run of the task's agents, oldest first, with what was asked each time. */
export function TaskConversation({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const key = (c.branches ?? []).map((b) => b.branch).join(",");
  const agents = useMemo(() => {
    const ids = new Set(key.split(","));
    return ctx.code.agents
      .filter((a) => ids.has(a.branchId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }, [ctx.code.agents, key]);
  const logs = useAgentLogs(agents, ctx.version);
  const nodes = useMemo(() => new Map(ctx.code.nodes.map((n) => [n.id, n])), [ctx.code.nodes]);

  if (!agents.length)
    return (
      <p className="muted pad-y">
        {c.branches?.length
          ? "This task's runs are in another source; open them from the Code tab there."
          : "No agent has worked on this task yet."}
      </p>
    );
  return (
    <div className="live task-live">
      {agents.map((a, i) => (
        <section key={a.id} className="run-section">
          <div className="msg user prompt">
            <span className="who">
              {i === 0 ? "Task prompt" : "Continued"} · {ago(a.startedAt)}
            </span>
            <PromptText text={a.prompt} />
          </div>
          <Transcript
            items={logs[a.id]?.items ?? []}
            nodes={nodes}
            short={ctx.codeShort}
            onSelectNode={(id) => ctx.openCode({ type: "node", id })}
            live={a.status === "running" || a.status === "starting"}
          />
        </section>
      ))}
    </div>
  );
}

/** Long assembled prompts fold after the first lines. */
function PromptText({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length <= 6) return <>{text}</>;
  return (
    <details>
      <summary>{lines.slice(0, 3).join("\n")}</summary>
      {lines.slice(3).join("\n")}
    </details>
  );
}

/** The files the agent cited as evidence, with their content. */
export function TaskOutputs({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const outputs = (ctx.kids.get(c.id) ?? []).filter((k) => k.kind === "output");
  const [open, setOpen] = useState<string | null>(outputs[0]?.id ?? null);
  if (!outputs.length)
    return (
      <p className="muted pad-y">
        No outputs yet. Files the agent cites as evidence for a finding show up here.
      </p>
    );
  return (
    <ul className="outputs">
      {outputs.map((o) => {
        const cites = ctx.graph.links.filter(
          (l) => !l.removed && l.rel === "evidence" && l.to.type === "concept" && l.to.id === o.id,
        );
        return (
          <li key={o.id} className={open === o.id ? "open" : ""}>
            <button
              type="button"
              className="output-head"
              aria-expanded={open === o.id}
              onClick={() => setOpen(open === o.id ? null : o.id)}
            >
              <span className="mono">{o.path}</span>
              <span className="muted small">
                {o.size !== undefined ? `${o.size.toLocaleString()} bytes` : ""}
                {cites.length ? ` · evidence for ${cites.length}` : ""}
              </span>
            </button>
            {open === o.id && <OutputBody ctx={ctx} o={o} />}
          </li>
        );
      })}
    </ul>
  );
}

function OutputBody({ ctx, o }: { ctx: GraphCtx; o: Concept }) {
  const [r, setR] = useState<OutputContentResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    get<OutputContentResponse>(`/api/outputs/${o.id}`).then(
      (x) => {
        setR(x);
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  }, [o.id, ctx.version]);
  const cites = ctx.graph.links
    .filter(
      (l) => !l.removed && l.rel === "evidence" && l.to.type === "concept" && l.to.id === o.id,
    )
    .map((l) => ctx.byId.get(l.from))
    .filter((x): x is Concept => Boolean(x));
  if (err) return <p className="bad small pad-y">{err}</p>;
  if (!r) return <p className="muted small pad-y">Loading…</p>;
  return (
    <div className="output-body">
      <p className="muted small">
        {r.at === "workspace" ? (
          "From the agent's workspace"
        ) : (
          <>
            From checkpoint{" "}
            <button
              type="button"
              className="link mono"
              onClick={() => ctx.openCode({ type: "node", id: r.at })}
            >
              {ctx.codeShort(r.at)}
            </button>
          </>
        )}
        {" · sha256 "}
        <span className="mono">{r.sha256.slice(0, 12)}</span>
        {!r.matches && <span className="warn"> · changed since the agent cited it</span>}
      </p>
      {cites.map((f) => (
        <button
          key={f.id}
          type="button"
          className="link-row small"
          onClick={() => ctx.select(f.id)}
        >
          <span className={`leaf-kind ${f.kind}`}>{f.kind}</span> {f.title}
        </button>
      ))}
      {r.binary ? (
        <p className="muted small">A binary file ({r.size.toLocaleString()} bytes).</p>
      ) : /\.csv$/i.test(r.path) && r.text ? (
        <CsvTable text={r.text} />
      ) : (
        <pre className="output-text">{r.text}</pre>
      )}
      {r.truncated && <p className="muted small">Showing the first 256 KB.</p>}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = text
    .trim()
    .split("\n")
    .slice(0, 201)
    .map((l) => l.split(","));
  const [head, ...body] = rows;
  if (!head) return null;
  return (
    <div className="csv-wrap">
      <table className="csv">
        <thead>
          <tr>
            {head.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
            <tr key={i}>
              {r.map((v, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The task's checkpoints, newest first; each opens in the Code tab with its diff. */
export function TaskCode({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const ids = taskBranchIds(ctx, c);
  const nodes = ctx.code.nodes
    .filter((n) => ids.has(n.branchId) && n.kind !== "micro")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const from = c.startFrom;
  return (
    <div className="task-code">
      {from && (
        <p className="muted small">
          Started from checkpoint{" "}
          <button
            type="button"
            className="link mono"
            onClick={() => ctx.openCode({ type: "node", id: from.checkpointId })}
          >
            {ctx.codeShort(from.checkpointId)}
          </button>{" "}
          of “{ctx.byId.get(from.taskId)?.title ?? "a task"}”.
        </p>
      )}
      {nodes.length === 0 ? (
        <p className="muted pad-y">No checkpoints yet.</p>
      ) : (
        <ul className="cp-list">
          {nodes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="cp-row"
                onClick={() => ctx.openCode({ type: "node", id: n.id })}
              >
                <span className={`dot ${statusTone(n.status)}`} />
                <span className="mono small">{ctx.codeShort(n.id)}</span>
                <span className="cp-sum">{firstLine(n.summary) || n.kind}</span>
                <span className="muted small">
                  {n.filesChanged ? `${n.filesChanged} files · ` : ""}
                  {STATUS_LABEL[n.status] ?? n.status} · {ago(n.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {[...ids].map((b) => (
        <button
          key={b}
          type="button"
          className="link small"
          onClick={() => ctx.openCode({ type: "branch", id: b })}
        >
          Open the branch in the Code tab →
        </button>
      ))}
    </div>
  );
}
