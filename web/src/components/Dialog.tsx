import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { Button, Notice } from "./ui";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** On a phone, take the full height of the screen (used for the "More" menu). */
  full?: boolean;
  /** When given, the dialog body and footer are wrapped in a form and Enter submits it. */
  onSubmit?: () => void;
}

/**
 * An in-page modal built on the native dialog element (focus is trapped and Escape closes it).
 * On a phone it is a sheet that rises from the bottom: the content scrolls inside it and the
 * buttons stay pinned at its foot.
 */
export function Dialog({ title, onClose, children, footer, wide, full, onSubmit }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!el.open) el.showModal();
    // On a wide screen the first field is focused, ready for typing. On a phone that would raise the
    // keyboard over half the sheet before it has been read, so only an explicitly marked button is focused.
    const phone = window.matchMedia("(max-width: 860px)").matches;
    const fields = ", .dialog-body input:not([type=hidden]):not([disabled]), .dialog-body select:not([disabled]), .dialog-body textarea:not([disabled])";
    const first = el.querySelector<HTMLElement>(`[data-autofocus]${phone ? "" : fields}`);
    first?.focus();
    return () => {
      if (el.open) el.close();
      previous?.focus?.();
    };
  }, []);

  const body = (
    <>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </>
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog-wide" : ""}${full ? " dialog-full" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onClick={(e) => {
        if (e.target === ref.current) closeRef.current();
      }}
    >
      <div className="dialog-panel">
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {onSubmit ? (
          <form className="dialog-form" onSubmit={submit} noValidate>
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Ask for a reason or remarks along with the confirmation. */
  reason?: "none" | "optional" | "required";
  reasonLabel?: string;
  reasonHint?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** Confirmation for anything that cannot be undone. Replaces window.confirm / prompt. */
export function ConfirmDialog({ title, message, confirmLabel, danger, reason = "none", reasonLabel = "Reason", reasonHint, busy, error, onConfirm, onCancel }: ConfirmProps) {
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = reason === "required" && !text.trim();
  const submit = () => {
    setTouched(true);
    if (missing || busy) return;
    onConfirm(text.trim());
  };
  return (
    <Dialog
      title={title}
      onClose={() => !busy && onCancel()}
      onSubmit={submit}
      footer={
        <>
          {/* With nothing to type, focus starts on the safe choice for a destructive action and on the confirmation otherwise. */}
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy} data-autofocus={reason === "none" && danger ? "" : undefined}>
            Go back
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} busy={busy} data-autofocus={reason === "none" && !danger ? "" : undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <div className="dialog-message">{message}</div>}
      {reason !== "none" && (
        <label className="field">
          <span className="field-label">
            {reasonLabel}
            {reason === "optional" && <span className="optional"> (optional)</span>}
          </span>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={touched && missing} maxLength={500} />
          {reasonHint && <span className="hint">{reasonHint}</span>}
          {touched && missing && <span className="field-error">Please enter {reasonLabel.toLowerCase()}.</span>}
        </label>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
