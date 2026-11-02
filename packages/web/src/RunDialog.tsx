import { useEffect, useRef } from "react";
import type { Ctx } from "./App.js";
import { Composer } from "./Composer.js";

export function RunDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="new-run-title">
      <div className="dialog-head">
        <h2 id="new-run-title">New run</h2>
        <button type="button" className="icon" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="muted small">
        Starts an agent on a new branch from <b>{ctx.state.repo.name}</b>'s current files. Your
        working copy is not touched: the agent works in its own copy.
      </p>
      <Composer ctx={ctx} mode="new" autoFocus submitLabel="Start run" onStarted={onClose} />
    </dialog>
  );
}
