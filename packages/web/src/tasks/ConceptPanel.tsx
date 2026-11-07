import { useEffect, useState } from "react";
import { type Concept, type ConceptDetailResponse, get, post } from "../api.js";
import { ago } from "../format.js";
import type { GraphCtx } from "./TasksView.js";
import { TASK_STATUS } from "./TasksView.js";
import { evidenceCount, lessonsFor } from "./tree.js";

interface Props {
  ctx: GraphCtx;
  id: string;
  onClose: () => void;
}

/** Detail and actions for one concept of the task graph. */
export function ConceptPanel({ ctx, id, onClose }: Props) {
  const c = ctx.byId.get(id) as Concept;
  const [detail, setDetail] = useState<ConceptDetailResponse | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on every change.
  useEffect(() => {
    get<ConceptDetailResponse>(`/api/concepts/${id}`).then(setDetail, () => {});
  }, [id, ctx.version]);

  const act = async (path: string, body: unknown, ok: string) => {
    try {
      const r = await post(path, body);
      if (ok) ctx.toast(ok, "ok");
      ctx.refresh();
      return r;
    } catch (err) {
      ctx.toast((err as Error).message, "bad");
      return null;
    }
  };

  const parent = c.parentId ? ctx.byId.get(c.parentId) : undefined;
  const kids = ctx.kids.get(c.id) ?? [];
  const lessons = lessonsFor(ctx.byId, ctx.kids, c.id).filter((l) => l.id !== c.id);
  const st = TASK_STATUS[c.status ?? "todo"];

  return (
    <div className="panel-inner">
      <div className="panel-head">
        <div className="panel-title">
          <span className="eyebrow">{c.kind}</span>
          {c.kind === "task" && st && <span className={`badge ${st.tone}`}>{st.label}</span>}
          {c.kind === "lesson" && (
            <span className={`badge ${c.lessonState === "confirmed" ? "ok" : "ask"}`}>
              {c.lessonState}
            </span>
          )}
          <span className="muted small">
            by {c.createdBy.type === "agent" ? `agent ${c.createdBy.id.slice(0, 6)}` : "you"} ·{" "}
            {ago(c.createdAt)}
          </span>
        </div>
        <button type="button" className="icon" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="panel-scroll pad">
        {parent && (
          <button type="button" className="link small" onClick={() => ctx.select(parent.id)}>
            ↑ {parent.title}
          </button>
        )}
        <EditableTitle ctx={ctx} c={c} />
        {c.kind === "task" && c.status === "todo" && ctx.graph.waiting?.[c.id] && (
          <p className="muted small">Not started: {ctx.graph.waiting[c.id]}.</p>
        )}

        {c.kind === "task" && <TaskSection ctx={ctx} c={c} act={act} />}
        {c.kind === "goal" && <GoalSection c={c} act={act} />}
        {c.kind === "question" && <QuestionBox ctx={ctx} q={c} act={act} />}
        {c.kind === "lesson" && <LessonSection c={c} act={act} detail={detail} ctx={ctx} />}
        {c.kind === "finding" && (
          <>
            {c.body && c.body !== c.title && <p className="node-body">{c.body}</p>}
            <Evidence ctx={ctx} id={c.id} />
          </>
        )}
        {c.kind === "decision" && c.body && <p className="node-body">{c.body}</p>}
        {c.kind === "output" && (
          <dl className="facts">
            <dt>Path</dt>
            <dd className="mono">{c.path}</dd>
            <dt>sha256</dt>
            <dd className="mono small">{c.sha256}</dd>
            <dt>Size</dt>
            <dd>{c.size?.toLocaleString()} bytes</dd>
          </dl>
        )}

        {lessons.length > 0 && (c.kind === "task" || c.kind === "goal") && (
          <section className="sec">
            <h4>Lessons this {c.kind} follows</h4>
            {lessons.map((l) => (
              <button
                key={l.id}
                type="button"
                className="lesson-chip"
                onClick={() => ctx.select(l.id)}
              >
                <span className={`badge ${l.lessonState === "confirmed" ? "ok" : "ask"}`}>
                  {l.lessonState}
                </span>{" "}
                {l.title}
              </button>
            ))}
          </section>
        )}

        {kids.length > 0 && (c.kind === "task" || c.kind === "goal") && (
          <section className="sec">
            <h4>Under this {c.kind}</h4>
            <ul className="kid-list">
              {kids.map((k) => (
                <li key={k.id}>
                  <button type="button" className="link-row" onClick={() => ctx.select(k.id)}>
                    <span className={`leaf-kind ${k.kind}`}>{k.kind}</span>{" "}
                    {k.kind === "output" ? k.path : k.title}
                    {k.kind === "task" && (
                      <span className="muted small">
                        {" "}
                        · {TASK_STATUS[k.status ?? "todo"]?.label}
                      </span>
                    )}
                    {k.kind === "finding" && evidenceCount(ctx.graph.links, k.id) === 0 && (
                      <span className="muted small"> · claimed</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {detail && detail.history.length > 0 && (
          <details className="sec">
            <summary className="muted small">History ({detail.history.length} changes)</summary>
            <ul className="history">
              {detail.history.map((h) => (
                <li key={h.id} className="small">
                  <span className="mono muted">{h.id.slice(0, 8)}</span> {h.kind} by{" "}
                  {h.actor.type === "agent" ? `agent ${h.actor.id.slice(0, 6)}` : "you"} ·{" "}
                  {ago(h.at)}{" "}
                  <button
                    type="button"
                    className="link small"
                    onClick={() => act(`/api/ops/${h.id}/undo`, {}, "Undone")}
                  >
                    undo
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

type Act = (path: string, body: unknown, ok: string) => Promise<unknown>;

function EditableTitle({ ctx, c }: { ctx: GraphCtx; c: Concept }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [body, setBody] = useState(c.body ?? "");
  if (!editing)
    return (
      <div className="title-block">
        <h2 className="node-title">{c.title}</h2>
        {(c.kind === "task" || c.kind === "goal") && c.body && (
          <p className="node-body">{c.body}</p>
        )}
        {(c.kind === "task" || c.kind === "goal" || c.kind === "lesson") && (
          <button type="button" className="link small" onClick={() => setEditing(true)}>
            Edit{c.kind === "task" && c.status === "running" ? " (the agent is told)" : ""}
          </button>
        )}
      </div>
    );
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(`/api/concepts/${c.id}`, { fields: { title, body }, base: c.version });
          ctx.toast(c.status === "running" ? "Saved; the agent will be told" : "Saved", "ok");
          ctx.refresh();
          setEditing(false);
        } catch (err) {
          ctx.toast((err as Error).message, "bad");
        }
      }}
    >
      <input id={`title-${c.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        id={`body-${c.id}`}
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="composer-actions">
        <button type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save
        </button>
      </div>
    </form>
  );
}

function TaskSection({ ctx, c, act }: { ctx: GraphCtx; c: Concept; act: Act }) {
  const running = c.status === "running";
  const gone = c.status === "abandoned" || c.status === "dropped";
  const [text, setText] = useState("");
  const [lesson, setLesson] = useState("");
  const [showAbandon, setShowAbandon] = useState(false);
  const [retryTitle, setRetryTitle] = useState("");
  const [subTitle, setSubTitle] = useState("");
  const openQs = (ctx.kids.get(c.id) ?? []).filter((k) => k.kind === "question" && !k.answer);
  const deps = (c.dependsOn ?? [])
    .map((d) => ctx.byId.get(d))
    .filter((d): d is Concept => Boolean(d));
  const verb = c.branches?.length ? "Continue" : "Start";

  return (
    <>
      {c.brief && (
        <section className="brief">
          <h4>Brief</h4>
          <p className="node-body">{c.brief}</p>
        </section>
      )}
      <dl className="facts">
        <dt>Done by</dt>
        <dd>{c.assignee?.type === "member" ? "you" : "an agent"}</dd>
        {deps.length > 0 && (
          <>
            <dt>After</dt>
            <dd>
              {deps.map((d) => (
                <button key={d.id} type="button" className="link" onClick={() => ctx.select(d.id)}>
                  {d.title} ({TASK_STATUS[d.status ?? "todo"]?.label}){" "}
                </button>
              ))}
            </dd>
          </>
        )}
        {c.startFrom && (
          <>
            <dt>Starts from</dt>
            <dd>
              checkpoint <span className="mono">{c.startFrom.checkpointId.slice(0, 8)}</span> of{" "}
              <button
                type="button"
                className="link"
                onClick={() => ctx.select(c.startFrom?.taskId ?? "")}
              >
                {ctx.byId.get(c.startFrom.taskId)?.title ?? "a task"}
              </button>
            </dd>
          </>
        )}
        {c.branches && c.branches.length > 0 && (
          <>
            <dt>Code</dt>
            <dd>
              {c.branches.map((b) => (
                <button
                  key={b.branch}
                  type="button"
                  className="link mono"
                  onClick={() => ctx.openBranch(b.branch)}
                >
                  {b.source}:{b.branch.slice(0, 6)}{" "}
                </button>
              ))}
              <span className="muted small"> (conversation, checkpoints, diffs)</span>
            </dd>
          </>
        )}
      </dl>

      {openQs.map((q) => (
        <QuestionBox key={q.id} ctx={ctx} q={q} act={act} />
      ))}

      {running ? (
        <section className="sec">
          <h4>Tell the agent</h4>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              if (
                await act(
                  `/api/tasks/${c.id}/tell`,
                  { text },
                  "Sent: it arrives at the agent's next tool call",
                )
              )
                setText("");
            }}
          >
            <textarea
              id={`tell-${c.id}`}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Change of plan, a hint, a constraint…"
            />
            <div className="composer-actions">
              <button
                type="button"
                onClick={() =>
                  act(`/api/tasks/${c.id}/pause`, {}, "Pausing at the next tool boundary")
                }
              >
                Pause
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => act(`/api/tasks/${c.id}/drop`, {}, "Dropping")}
              >
                Drop
              </button>
              <button type="submit" className="primary" disabled={!text.trim()}>
                Send
              </button>
            </div>
          </form>
        </section>
      ) : (
        !gone &&
        openQs.length === 0 &&
        c.assignee?.type === "agent" && (
          <section className="sec">
            <h4>{verb} the agent</h4>
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    `/api/tasks/${c.id}/start`,
                    text.trim() ? { instruction: text } : {},
                    `${verb}ed`,
                  )
                )
                  setText("");
              }}
            >
              <textarea
                id={`start-${c.id}`}
                rows={2}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  verb === "Continue"
                    ? "What next? (optional)"
                    : "Anything to add for the agent? (optional)"
                }
              />
              <div className="composer-actions">
                <button type="submit" className="primary">
                  {verb}
                </button>
              </div>
            </form>
          </section>
        )
      )}

      <section className="sec actions-row">
        {!gone && (
          <button type="button" onClick={() => setShowAbandon((v) => !v)}>
            Abandon…
          </button>
        )}
        {gone && c.status === "abandoned" && (
          <span className="muted small">Kept in the record; its lesson is on the node above.</span>
        )}
      </section>
      {showAbandon && (
        <form
          className="stack sec"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act(
                `/api/tasks/${c.id}/abandon`,
                lesson.trim() ? { lesson } : {},
                "Abandoned; lesson added above",
              )
            ) {
              setShowAbandon(false);
              setLesson("");
            }
          }}
        >
          <label className="field">
            What should later attempts learn from this?
            <textarea
              id={`lesson-${c.id}`}
              rows={3}
              value={lesson}
              onChange={(e) => setLesson(e.target.value)}
              placeholder="Leave empty to draft it from this task's findings (you can edit it afterwards)"
            />
          </label>
          <div className="composer-actions">
            <button type="submit" className="danger">
              Abandon and keep the lesson
            </button>
          </div>
        </form>
      )}

      {c.parentId && (
        <form
          className="inline sec"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!retryTitle.trim()) return;
            const r = (await act(
              `/api/nodes-retry/${c.parentId}`,
              { title: retryTitle },
              "Added: it starts with the lessons above",
            )) as Concept | null;
            if (r) {
              setRetryTitle("");
              ctx.select(r.id);
            }
          }}
        >
          <input
            id={`retry-${c.id}`}
            value={retryTitle}
            onChange={(e) => setRetryTitle(e.target.value)}
            placeholder="Try another way (a sibling task)…"
          />
          <button type="submit" disabled={!retryTitle.trim()}>
            Try
          </button>
        </form>
      )}
      <form
        className="inline sec"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!subTitle.trim()) return;
          if (
            await act(
              "/api/concepts",
              { kind: "task", parentId: c.id, title: subTitle, assignee: { type: "agent" } },
              "Subtask added",
            )
          )
            setSubTitle("");
        }}
      >
        <input
          id={`sub-${c.id}`}
          value={subTitle}
          onChange={(e) => setSubTitle(e.target.value)}
          placeholder="Add a subtask…"
        />
        <button type="submit" disabled={!subTitle.trim()}>
          Add
        </button>
      </form>
    </>
  );
}

function GoalSection({ c, act }: { c: Concept; act: Act }) {
  const [title, setTitle] = useState("");
  const [lesson, setLesson] = useState("");
  return (
    <>
      <form
        className="inline sec"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          if (
            await act(
              "/api/concepts",
              { kind: "task", parentId: c.id, title, assignee: { type: "agent" } },
              "Task added",
            )
          )
            setTitle("");
        }}
      >
        <input
          id={`task-${c.id}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task…"
        />
        <button type="submit" disabled={!title.trim()}>
          Add
        </button>
      </form>
      <form
        className="inline sec"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!lesson.trim()) return;
          if (
            await act(
              "/api/concepts",
              {
                kind: "lesson",
                parentId: c.id,
                title: lesson.split("\n")[0],
                body: lesson,
                lessonState: "confirmed",
              },
              "Lesson added: every task under this goal gets it",
            )
          )
            setLesson("");
        }}
      >
        <input
          id={`glesson-${c.id}`}
          value={lesson}
          onChange={(e) => setLesson(e.target.value)}
          placeholder="Add a lesson for everything under this goal…"
        />
        <button type="submit" disabled={!lesson.trim()}>
          Add
        </button>
      </form>
    </>
  );
}

function QuestionBox({ ctx, q, act }: { ctx: GraphCtx; q: Concept; act: Act }) {
  const [text, setText] = useState("");
  if (q.answer)
    return (
      <p className="node-body">
        Answered by you: <b>{q.answer.text}</b>
      </p>
    );
  const send = async (answer: string) => {
    if (!answer.trim()) return;
    const r = (await act(`/api/questions/${q.id}/answer`, { text: answer }, "")) as {
      started?: unknown;
    } | null;
    if (r) {
      ctx.toast(r.started ? "Answered; the agent continues" : "Answered", "ok");
      setText("");
    }
  };
  return (
    <section className="ask-box">
      <b>The agent asks</b>
      <p>{q.title}</p>
      {q.options && q.options.length > 0 && (
        <div className="actions-row">
          {q.options.map((o) => (
            <button key={o} type="button" onClick={() => send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          id={`answer-${q.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your answer…"
        />
        <button type="submit" className="primary" disabled={!text.trim()}>
          Answer
        </button>
      </form>
    </section>
  );
}

function LessonSection({
  ctx,
  c,
  act,
  detail,
}: {
  ctx: GraphCtx;
  c: Concept;
  act: Act;
  detail: ConceptDetailResponse | null;
}) {
  const from = detail?.links.find((l) => l.rel === "provenance" && l.to.type === "concept");
  const src = from ? ctx.byId.get(from.to.id) : undefined;
  return (
    <>
      {c.body && c.body !== c.title && <p className="node-body">{c.body}</p>}
      {src && (
        <p className="small">
          Learned from{" "}
          <button type="button" className="link" onClick={() => ctx.select(src.id)}>
            {src.title}
          </button>{" "}
          ({TASK_STATUS[src.status ?? ""]?.label ?? src.kind})
        </p>
      )}
      <p className="muted small">
        Every task under “{ctx.byId.get(c.parentId ?? "")?.title}” gets this lesson in its prompt.
      </p>
      <div className="actions-row">
        {c.lessonState !== "confirmed" && (
          <button
            type="button"
            className="primary"
            onClick={() =>
              act(
                `/api/concepts/${c.id}`,
                { fields: { lessonState: "confirmed" } },
                "Lesson confirmed",
              )
            }
          >
            Confirm
          </button>
        )}
        {c.lessonState !== "superseded" && (
          <button
            type="button"
            onClick={() =>
              act(
                `/api/concepts/${c.id}`,
                { fields: { lessonState: "superseded" } },
                "Lesson superseded",
              )
            }
          >
            Supersede
          </button>
        )}
      </div>
    </>
  );
}

function Evidence({ ctx, id }: { ctx: GraphCtx; id: string }) {
  const ev = ctx.graph.links.filter((l) => l.from === id && l.rel === "evidence" && !l.removed);
  if (!ev.length) return <p className="muted small">No evidence attached: shown as claimed.</p>;
  return (
    <section className="sec">
      <h4>Evidence</h4>
      <ul className="kid-list">
        {ev.map((l) => {
          const t = l.to.type === "concept" ? ctx.byId.get(l.to.id) : undefined;
          return (
            <li key={l.id} className="small">
              {t ? (
                <button type="button" className="link" onClick={() => ctx.select(t.id)}>
                  {t.kind === "output" ? t.path : t.title}
                </button>
              ) : (
                <span className="mono">
                  {l.to.type} {l.to.id.slice(0, 8)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
