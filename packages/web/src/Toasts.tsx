export interface Toast {
  id: string;
  text: string;
  tone: "info" | "ok" | "warn" | "bad";
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button
          type="button"
          key={t.id}
          className={`toast ${t.tone}`}
          onClick={() => onDismiss(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
