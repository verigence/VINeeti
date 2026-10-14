import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

interface ToastItem {
  id: number;
  kind: "ok" | "error";
  text: string;
}
export interface ToastApi {
  ok: (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = createContext<ToastApi>({ ok: () => undefined, error: () => undefined });
export const useToast = () => useContext(ToastContext);

/** Short success and error messages after an action, shown at the bottom of the screen. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastItem["kind"], text: string) => {
      const id = next.current++;
      setItems((list) => [...list.slice(-2), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "ok" ? 5000 : 9000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => ({ ok: (t) => push("ok", t), error: (t) => push("error", t) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon name={t.kind === "ok" ? "check" : "warning"} />
            <span className="toast-text">
              <span className="sr-only">{t.kind === "ok" ? "Done: " : "Problem: "}</span>
              {t.text}
            </span>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss message">
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
