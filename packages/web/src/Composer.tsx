import { useEffect, useRef, useState } from "react";
import type { Ctx } from "./App.js";
import { post, type RunRequest, type RunResponse, type SandboxMode } from "./api.js";

export type ComposeMode = "new" | "continue" | "fork";

interface Props {
  ctx: Ctx;
  mode: ComposeMode;
  /** Node to continue or fork from (omit for a new run). */
  from?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onStarted?: (r: RunResponse) => void;
}

/** Prompt box that starts a run: new branch, continue a branch head, or fork from a node. */
export function Composer({
  ctx,
  mode,
  from,
  placeholder,
  submitLabel,
  autoFocus,
  onStarted,
}: Props) {
  const d = ctx.state.defaults;
  const [prompt, setPrompt] = useState("");
  const [sandbox, setSandbox] = useState<SandboxMode>(d.sandbox);
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState("");
  const [name, setName] = useState("");
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    const body: RunRequest = { prompt: prompt.trim(), sandbox };
    if (from) body.from = from;
    if (mode === "fork") body.fork = true;
    if (mode === "new" && !includeUncommitted) body.fromHead = true;
    if (model.trim()) body.model = model.trim();
    if (budget.trim()) body.budget = Number(budget);
    if (name.trim() && mode !== "continue") body.name = name.trim();
    try {
      const r = await post<RunResponse>("/api/runs", body);
      setPrompt("");
      ctx.toast(
        r.mode === "continue"
          ? "Agent continues this branch"
          : r.mode === "fork"
            ? "Forked: new branch started"
            : "Run started",
        "ok",
      );
      onStarted?.(r);
      ctx.select({ type: "branch", id: r.branchId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        value={prompt}
        rows={3}
        placeholder={placeholder ?? "What should the agent do?"}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <details className="options">
        <summary>Options</summary>
        <div className="grid">
          <label>
            Sandbox
            <select value={sandbox} onChange={(e) => setSandbox(e.target.value as SandboxMode)}>
              <option value="none">none (child process)</option>
              <option value="docker">docker (container)</option>
            </select>
          </label>
          <label>
            Model
            <input
              value={model}
              placeholder={d.model ?? "default"}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            Budget (USD)
            <input
              value={budget}
              inputMode="decimal"
              placeholder={d.maxBudgetUsd ? String(d.maxBudgetUsd) : "none"}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          {mode !== "continue" && (
            <label>
              Branch name
              <input
                value={name}
                placeholder="optional"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          {mode === "new" && (
            <label className="check">
              <input
                type="checkbox"
                checked={includeUncommitted}
                onChange={(e) => setIncludeUncommitted(e.target.checked)}
              />
              Include my uncommitted changes
            </label>
          )}
        </div>
      </details>
      {error && <p className="bad small">{error}</p>}
      <div className="composer-actions">
        <span className="muted small">⌘/Ctrl + Enter</span>
        <button type="submit" className="primary" disabled={busy || !prompt.trim()}>
          {busy ? "Starting…" : (submitLabel ?? "Start")}
        </button>
      </div>
    </form>
  );
}
