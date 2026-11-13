import { useEffect, useRef, useState } from "react";
import { post } from "../api.js";
import type { GraphCtx } from "./TasksView.js";

export const MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
];

export const EFFORTS: [string, string][] = [
  ["low", "low: quick, few tool calls; simple tasks"],
  ["medium", "medium: balanced"],
  ["high", "high: thinks more; most coding work"],
  ["xhigh", "xhigh: long, hard agentic work"],
  ["max", "max: as much as it takes; slowest, most tokens"],
];

export const modelName = (id: string | undefined) =>
  id ? (MODELS.find(([m]) => m === id)?.[1].replace("Claude ", "") ?? id) : "default model";

/** A thinking-effort picker; "" means the default (project, then the model's own). */
export function EffortSelect({
  id,
  value,
  onChange,
  inherit,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  inherit: string;
}) {
  return (
    <label className="effort-pick small" htmlFor={id}>
      Thinking
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{inherit}</option>
        {EFFORTS.map(([v]) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The project's agent defaults: model and thinking effort (turtle-project.json). */
export function AgentSettingsDialog({ ctx, onClose }: { ctx: GraphCtx; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const d = ctx.defaults ?? {};
  const known = MODELS.some(([m]) => m === d.model);
  const [model, setModel] = useState(d.model ? (known ? d.model : "other") : "");
  const [other, setOther] = useState(known ? "" : (d.model ?? ""));
  const [effort, setEffort] = useState(d.effort ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="agents-title">
      <div className="dialog-head">
        <h2 id="agents-title">Agents</h2>
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
            await post("/api/project/defaults", {
              model: model === "other" ? other.trim() || null : model || null,
              effort: effort || null,
            });
            ctx.toast("Saved: tasks started from now on use it", "ok");
            ctx.refresh();
            onClose();
          } catch (err) {
            ctx.toast((err as Error).message, "bad");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small">
          For every task this project starts from now on, unless you pick something else when you
          start one. Saved in the project's turtle-project.json.
        </p>
        <label className="field">
          Model
          <select id="agents-model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default (turtle.config.json)</option>
            {MODELS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            <option value="other">Another model id…</option>
          </select>
        </label>
        {model === "other" && (
          <input
            id="agents-model-other"
            className="mono"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="claude-…"
          />
        )}
        <fieldset className="effort-list">
          <legend>Thinking</legend>
          <label className="check">
            <input
              type="radio"
              name="effort"
              checked={effort === ""}
              onChange={() => setEffort("")}
            />
            Default: the model decides (Opus 5.5 and Haiku 5.5 default to medium)
          </label>
          {EFFORTS.map(([v, label]) => (
            <label key={v} className="check">
              <input
                type="radio"
                name="effort"
                checked={effort === v}
                onChange={() => setEffort(v)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="muted small">
          More thinking usually means better work on hard tasks, more tokens and slower runs.
        </p>
        <div className="composer-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
