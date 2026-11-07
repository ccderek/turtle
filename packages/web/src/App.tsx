import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, type LiveEvent, type StateResponse, useLive } from "./api.js";
import { BranchPanel } from "./BranchPanel.js";
import { shortIds } from "./format.js";
import { NodePanel } from "./NodePanel.js";
import { RunDialog } from "./RunDialog.js";
import { Sidebar } from "./Sidebar.js";
import { type Toast, Toasts } from "./Toasts.js";
import { TreeView } from "./TreeView.js";
import { TasksView } from "./tasks/TasksView.js";

type View = "tasks" | "code";

function readView(): View | null {
  if (/^#\/c\//.test(window.location.hash)) return "tasks";
  if (/^#\/(node|branch)\//.test(window.location.hash)) return "code";
  return null;
}

function readConcept(): string | null {
  const m = /^#\/c\/([\w-]+)$/.exec(window.location.hash);
  return m ? (m[1] as string) : null;
}

export type Selection =
  | { type: "node"; id: string; compose?: boolean }
  | { type: "branch"; id: string };

export interface Ctx {
  state: StateResponse;
  short: (id: string) => string;
  /** Bumps on every database change; panels refetch when it moves. */
  version: number;
  select: (s: Selection | null) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
}

function readHash(): Selection | null {
  const m = /^#\/(node|branch)\/([\w-]+)$/.exec(window.location.hash);
  if (!m) return null;
  return m[1] === "node"
    ? { type: "node", id: m[2] as string }
    : { type: "branch", id: m[2] as string };
}

function readPref(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writePref(key: string, v: boolean): void {
  try {
    window.localStorage.setItem(key, v ? "1" : "0");
  } catch {}
}

export function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(() => readPref("turtle.showSteps"));
  const [selection, setSelection] = useState<Selection | null>(readHash);
  const [version, setVersion] = useState(0);
  const [newRun, setNewRun] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hasProject, setHasProject] = useState(false);
  const [view, setView] = useState<View>(() => readView() ?? "tasks");
  const [concept, setConcept] = useState<string | null>(readConcept);

  useEffect(() => {
    get("/api/project").then(
      () => setHasProject(true),
      () => setHasProject(false),
    );
  }, []);

  const selectConcept = useCallback((id: string | null) => {
    setConcept(id);
    const hash = id ? `#/c/${id}` : "";
    if (window.location.hash !== hash)
      window.history.replaceState(null, "", hash || window.location.pathname);
  }, []);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-4), { id, text, tone }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === "bad" ? 10_000 : 5_000,
    );
  }, []);

  // Coalesced refetch: at most one request in flight, one more queued.
  const inflight = useRef(false);
  const dirty = useRef(false);
  const microRef = useRef(showSteps);
  microRef.current = showSteps;
  const refresh = useCallback(async () => {
    if (inflight.current) {
      dirty.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        dirty.current = false;
        const s = await get<StateResponse>(`/api/state${microRef.current ? "?micro=1" : ""}`);
        setState(s);
        setError(null);
      } while (dirty.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inflight.current = false;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toggling steps changes the query.
  useEffect(() => {
    void refresh();
  }, [refresh, showSteps]);

  const conn = useLive((e: LiveEvent) => {
    if (e.type === "change" || e.type === "hello") {
      void refresh();
      setVersion((v) => v + 1);
    } else if (e.type === "log") {
      toast(e.message, e.level === "error" ? "bad" : "warn");
    }
  });

  const select = useCallback((s: Selection | null) => {
    setSelection(s);
    const hash = s ? `#/${s.type}/${s.id}` : "";
    if (window.location.hash !== hash)
      window.history.replaceState(null, "", hash || window.location.pathname);
  }, []);

  useEffect(() => {
    const onHash = () => {
      setSelection(readHash());
      setConcept(readConcept());
      const v = readView();
      if (v) setView(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLInputElement)
      ) {
        select(null);
        selectConcept(null);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, [select, selectConcept]);

  const short = useMemo(
    () =>
      shortIds([
        ...(state?.nodes.map((n) => n.id) ?? []),
        ...(state?.branches.map((b) => b.id) ?? []),
      ]),
    [state],
  );

  const waiting = state?.attention.length ?? 0;
  useEffect(() => {
    document.title = `${waiting ? `(${waiting}) ` : ""}turtle${state ? ` · ${state.repo.name}` : ""}`;
  }, [waiting, state]);

  if (!state) {
    return (
      <div className="boot">
        {error ? (
          <>
            <p className="bad">Cannot reach turtle: {error}</p>
            <p className="muted">
              Is <code>turtle ui</code> still running?
            </p>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  }

  const ctx: Ctx = { state, short, version, select, toast };
  const tasksMode = hasProject && view === "tasks";
  const tabs = hasProject ? (
    <div className="view-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tasksMode}
        className={tasksMode ? "on" : ""}
        onClick={() => setView("tasks")}
      >
        Tasks
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={!tasksMode}
        className={!tasksMode ? "on" : ""}
        onClick={() => setView("code")}
      >
        Code
      </button>
    </div>
  ) : null;
  const panel = selection ? (
    selection.type === "node" ? (
      <NodePanel
        key={selection.id}
        ctx={ctx}
        nodeId={selection.id}
        compose={selection.compose ?? false}
      />
    ) : (
      <BranchPanel key={selection.id} ctx={ctx} branchId={selection.id} />
    )
  ) : null;

  return (
    <div
      className={`app${panel && !tasksMode ? " with-panel" : ""}${tasksMode ? " tasks-mode" : ""}`}
    >
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <strong>turtle</strong>
          <span className="repo" title={state.repo.root}>
            {state.repo.name}
          </span>
        </div>
        {tabs}
        <div className="stats">
          <span
            className={`conn ${conn}`}
            title={conn === "live" ? "Live updates on" : "Reconnecting…"}
          >
            {conn === "live" ? "live" : conn === "connecting" ? "connecting" : "offline"}
          </span>
          <span>
            <b>{state.totals.running}</b> running
          </span>
          <span>
            <b>{waiting}</b> need you
          </span>
          <span>
            <b>${state.totals.costUsd.toFixed(2)}</b> spent
          </span>
        </div>
        <div className="actions">
          {!tasksMode && (
            <label className="toggle" title="Show every tool call (micro snapshots) in the tree">
              <input
                type="checkbox"
                checked={showSteps}
                onChange={(e) => {
                  setShowSteps(e.target.checked);
                  writePref("turtle.showSteps", e.target.checked);
                }}
              />
              Show steps
            </label>
          )}
          {!tasksMode && (
            <button type="button" className="primary" onClick={() => setNewRun(true)}>
              New run
            </button>
          )}
        </div>
      </header>
      {error && <div className="banner bad">Connection problem: {error}</div>}
      {tasksMode ? (
        <div className="tasks-area">
          <TasksView
            version={version}
            toast={toast}
            selected={concept}
            onSelect={selectConcept}
            openBranch={(id) => {
              setView("code");
              select({ type: "branch", id });
            }}
          />
        </div>
      ) : (
        <>
          <Sidebar ctx={ctx} selection={selection} />
          <main className="tree-area">
            <TreeView
              ctx={ctx}
              selection={selection}
              showSteps={showSteps}
              onNewRun={() => setNewRun(true)}
            />
          </main>
          {panel && <aside className="panel">{panel}</aside>}
        </>
      )}
      {newRun && <RunDialog ctx={ctx} onClose={() => setNewRun(false)} />}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}
