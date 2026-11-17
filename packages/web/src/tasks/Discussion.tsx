import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentView, type Concept, post, type TranscriptItem } from "../api.js";
import { ago } from "../format.js";
import { useAgentLogs } from "../useAgentLogs.js";
import type { GraphCtx } from "./TasksView.js";

/**
 * A discussion task (architecture §3.8): the member and an agent think something through,
 * turn by turn. Each turn ends at a checkpoint you can branch from; what is settled is
 * recorded as decisions, which can be hardened into lessons and tasks.
 */

/** The member's words in a run's prompt: notes turtle put before them are dropped. */
function spoken(prompt: string): string {
  const parts = prompt.split("\n\n");
  while (parts.length > 1 && parts[0]?.startsWith("[turtle]")) parts.shift();
  return parts.join("\n\n").trim();
}

function decisionText(it: Extract<TranscriptItem, { kind: "tool_use" }>): string {
  try {
    const v = JSON.parse(it.input) as { text?: string };
    if (v.text) return v.text;
  } catch {}
  return it.summary;
}

async function send(ctx: GraphCtx, path: string, body: unknown): Promise<unknown> {
  try {
    const r = await post<unknown>(path, body);
    ctx.refresh();
    return r;
  } catch (err) {
    ctx.toast((err as Error).message, "bad");
    return null;
  }
}

export function DiscussionView({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const key = (c.branches ?? []).map((b) => b.branch).join(",");
  const agents = useMemo(() => {
    const ids = new Set(key.split(","));
    return ctx.code.agents
      .filter((a) => ids.has(a.branchId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }, [ctx.code.agents, key]);
  const logs = useAgentLogs(agents, ctx.version);
  const running = c.status === "running" || agents.some((a) => a.status === "running");
  const from = c.startFrom ? ctx.byId.get(c.startFrom.taskId) : undefined;
  const decisions = (ctx.kids.get(c.id) ?? []).filter((k) => k.kind === "decision" && !k.dropped);
  const branches = ctx.graph.concepts.filter(
    (t) => t.kind === "task" && t.startFrom?.taskId === c.id && !t.dropped,
  );
  return (
    <div className="discussion">
      {from && (
        <p className="muted small">
          Branched from{" "}
          <button type="button" className="link" onClick={() => ctx.select(from.id)}>
            {from.title}
          </button>{" "}
          at one of its turns; the conversation up to there carries over.
        </p>
      )}
      {!agents.length && (
        <div className="bubble human">
          <span className="who">You</span>
          {c.body || c.title}
        </div>
      )}
      {agents.map((a, i) => (
        <Turn
          key={a.id}
          ctx={ctx}
          c={c}
          agent={a}
          n={i + 1}
          said={i === 0 && !from ? c.body || c.title : spoken(a.prompt)}
          items={logs[a.id]?.items ?? []}
        />
      ))}
      {running && (
        <div className="bubble agent thinking-bubble">
          <span className="run-dot" /> thinking…
        </div>
      )}
      <Composer ctx={ctx} c={c} running={running} />
      {decisions.length > 0 && (
        <section className="sec settled">
          <h4>Settled so far</h4>
          {decisions.map((d) => (
            <DecisionCard key={d.id} ctx={ctx} d={d} />
          ))}
        </section>
      )}
      {branches.length > 0 && (
        <section className="sec">
          <h4>Branches</h4>
          <ul className="plain">
            {branches.map((b) => (
              <li key={b.id}>
                <button type="button" className="link" onClick={() => ctx.select(b.id)}>
                  {b.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Turn({
  ctx,
  c,
  agent,
  n,
  said,
  items,
}: {
  ctx: GraphCtx;
  c: Concept;
  agent: AgentView;
  n: number;
  said: string;
  items: TranscriptItem[];
}) {
  const [branching, setBranching] = useState(false);
  const [text, setText] = useState("");
  const end = ctx.code.nodes
    .filter((x) => x.agentId === agent.id && x.kind === "semantic")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  const main = items.filter((it) => !it.sub);
  const tools = main.filter(
    (it): it is Extract<TranscriptItem, { kind: "tool_use" }> => it.kind === "tool_use",
  );
  const looked = tools.filter((t) => !t.name.startsWith("mcp__turtle__")).length;
  return (
    <div className="turn">
      <div className="bubble human">
        <span className="who">You · {ago(agent.startedAt)}</span>
        {said}
      </div>
      {main.map((it) =>
        it.kind === "text" ? (
          <div key={`${it.agentId}-${it.seq}`} className="bubble agent">
            {it.text}
          </div>
        ) : it.kind === "tool_use" && it.name === "mcp__turtle__decision" ? (
          <div key={`${it.agentId}-${it.seq}`} className="settled-chip">
            Decided: {decisionText(it)}
          </div>
        ) : null,
      )}
      {end && agent.status !== "running" && (
        <div className="turn-end">
          <span className="muted small">
            turn {n}
            {looked ? ` · looked at ${looked} thing(s)` : ""} · checkpoint{" "}
            <button
              type="button"
              className="link mono"
              onClick={() => ctx.openCode({ type: "node", id: end.id })}
            >
              {ctx.codeShort(end.id)}
            </button>
          </span>
          {!branching && (
            <button type="button" className="link small" onClick={() => setBranching(true)}>
              Branch from here…
            </button>
          )}
        </div>
      )}
      {branching && end && (
        <form
          className="stack branch-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = (await send(ctx, `/api/tasks/${c.id}/branch`, {
              checkpointId: end.id,
              text,
            })) as { task: Concept } | null;
            if (r) {
              setBranching(false);
              ctx.toast("Branch added: the conversation goes on from that turn", "ok");
              ctx.select(r.task.id);
            }
          }}
        >
          <textarea
            id={`branch-${end.id}`}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What you would say at this point instead…"
          />
          <div className="composer-actions">
            <button type="button" onClick={() => setBranching(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!text.trim()}>
              Branch
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Composer({ ctx, c, running }: { ctx: GraphCtx; c: Concept; running: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const say = async (path: string, body: unknown) => {
    setBusy(true);
    const r = await send(ctx, path, body);
    setBusy(false);
    if (r) setText("");
  };
  const done = c.status === "done";
  return (
    <form
      className="stack composer discussion-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void say(`/api/tasks/${c.id}/say`, { text });
      }}
    >
      <textarea
        id={`say-${c.id}`}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim())
            void say(`/api/tasks/${c.id}/say`, { text });
        }}
        placeholder={
          done
            ? "Concluded. Write to reopen it…"
            : running
              ? "The agent is answering; your message reaches it at its next step…"
              : "Your reply…"
        }
      />
      <div className="composer-actions">
        {!done && (
          <button
            type="button"
            disabled={busy || running}
            title="The agent records what is settled, what is open and what to do, then concludes"
            onClick={() => void say(`/api/tasks/${c.id}/wrap-up`, {})}
          >
            Wrap up
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

/** A decision with what was not chosen, and how to harden it. */
export function DecisionCard({ ctx, d }: { ctx: GraphCtx; d: Concept }) {
  const made = ctx.graph.links.filter(
    (l) => l.rel === "provenance" && l.to.type === "concept" && l.to.id === d.id,
  );
  const lesson = made.map((l) => ctx.byId.get(l.from)).find((x) => x?.kind === "lesson");
  const task = made.map((l) => ctx.byId.get(l.from)).find((x) => x?.kind === "task");
  return (
    <div className="decision-card">
      <div>
        <button type="button" className="link" onClick={() => ctx.select(d.id)}>
          {d.title}
        </button>
      </div>
      {d.alternatives && d.alternatives.length > 0 && (
        <ul className="alternatives small">
          {d.alternatives.map((a) => (
            <li key={a}>
              <span className="muted">not:</span> {a}
            </li>
          ))}
        </ul>
      )}
      <div className="actions-row small">
        {lesson ? (
          <button type="button" className="link" onClick={() => ctx.select(lesson.id)}>
            ✓ lesson
          </button>
        ) : (
          <button
            type="button"
            title="Every later task under this goal follows it"
            onClick={async () => {
              const r = await send(ctx, `/api/decisions/${d.id}/lesson`, {});
              if (r) ctx.toast("Lesson added: later tasks under this goal follow it", "ok");
            }}
          >
            Make it a lesson
          </button>
        )}
        {task ? (
          <button type="button" className="link" onClick={() => ctx.select(task.id)}>
            ✓ task: {task.title}
          </button>
        ) : (
          <button
            type="button"
            title="An agent does it, with the decision and what was not chosen in its prompt"
            onClick={async () => {
              const r = await send(ctx, `/api/decisions/${d.id}/task`, {});
              if (r) ctx.toast("Task added from the decision", "ok");
            }}
          >
            Make it a task
          </button>
        )}
      </div>
    </div>
  );
}

/** Start a discussion: under a goal or task, or as a new goal of its own. */
export function NewDiscussionDialog({
  ctx,
  parent,
  onClose,
}: {
  ctx: GraphCtx;
  parent?: Concept;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="new-talk-title">
      <div className="dialog-head">
        <h2 id="new-talk-title">New discussion{parent ? ` under “${parent.title}”` : ""}</h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await post<{ discussion: Concept }>("/api/discussions", {
              topic,
              message,
              ...(parent ? { parentId: parent.id } : {}),
            });
            ctx.refresh();
            ctx.select(r.discussion.id);
            onClose();
          } catch (err) {
            ctx.toast((err as Error).message, "bad");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small">
          Think something through with an agent, turn by turn. It does not change files unless you
          ask. What gets settled is recorded as decisions (with what was not chosen), which you can
          turn into lessons and tasks.{parent ? "" : " The topic becomes a new goal."}
        </p>
        <label className="field">
          Topic
          <input
            id="talk-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="How should we validate the strategy?"
          />
        </label>
        <label className="field">
          Your first message
          <textarea
            id="talk-message"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What you are unsure about, what you already know"
          />
        </label>
        <div className="composer-actions">
          <button type="submit" className="primary" disabled={busy || !topic.trim()}>
            {busy ? "Starting…" : "Start the discussion"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
