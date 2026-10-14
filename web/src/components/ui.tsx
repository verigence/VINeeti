// Small building blocks shared by every screen.

import { Fragment, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Loaded } from "../hooks";
import type { Label, Tone } from "../labels";
import { Link } from "../router";
import { Icon, type IconName } from "./icons";

// ---------------------------------------------------------------- buttons
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "sm";
  busy?: boolean;
  icon?: IconName;
}

export function Button({ variant = "secondary", size = "md", busy, icon, children, disabled, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant}${size === "sm" ? " btn-sm" : ""}${className ? ` ${className}` : ""}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function LinkButton({ to, variant = "secondary", size = "md", icon, children }: { to: string; variant?: "primary" | "secondary" | "ghost"; size?: "md" | "sm"; icon?: IconName; children: ReactNode }) {
  return (
    <Link to={to} className={`btn btn-${variant}${size === "sm" ? " btn-sm" : ""}`}>
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
    </Link>
  );
}

// ---------------------------------------------------------------- status chip: colour and words together
export function Chip({ tone = "grey", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`chip chip-${tone}`}>
      <span className="chip-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
export const StatusChip = ({ label }: { label: Label }) => <Chip tone={label.tone}>{label.text}</Chip>;

// ---------------------------------------------------------------- layout
/**
 * The page's title row. `primary` is the page's main action: next to the other actions on a wide
 * screen, and in a bar fixed above the tab bar on a phone so it can be reached with a thumb.
 */
export function PageHeader({ title, subtitle, actions, primary, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; primary?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {back && (
          <Link to={back.to} className="back-link">
            <Icon name="back" size={14} />
            {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {(actions || primary) && (
        <div className="page-actions">
          {primary && <ActionBar inline>{primary}</ActionBar>}
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * Holds a screen's main buttons (Save, Submit, New booking). On a phone it is fixed above the tab bar;
 * on a wide screen it is an ordinary row (or, with `inline`, its buttons simply join the row they are in).
 */
export function ActionBar({ children, inline, sticky }: { children: ReactNode; inline?: boolean; sticky?: boolean }) {
  return <div className={`action-bar${inline ? " action-bar-inline" : ""}${sticky ? " action-bar-sticky" : ""}`}>{children}</div>;
}

/**
 * The search box and filters above a list. On a phone the filters fold away behind a "Filters" button
 * that shows how many are in use; the search box, if any, stays visible.
 */
export function FilterBar({ search, children, active, onClear }: { search?: ReactNode; children: ReactNode; active: number; onClear?: () => void }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="filterbar">
      <div className="filterbar-top">
        {search}
        <button type="button" className="btn btn-secondary filters-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
          <Icon name="filter" size={16} />
          <span>Filters</span>
          {active > 0 && (
            <span className="tab-count">
              {active}
              <span className="sr-only"> in use</span>
            </span>
          )}
        </button>
      </div>
      <div id={panel} className={`filters${open ? " filters-open" : ""}`}>
        {children}
        {active > 0 && onClear && (
          <div className="filters-actions">
            <Button variant="ghost" onClick={onClear}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Card({ title, actions, children, flush, className, note }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; note?: ReactNode }) {
  return (
    <section className={`card${flush ? " card-flush" : ""}${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {note && <p className="card-note">{note}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Tabs({ tabs, current }: { tabs: { to: string; label: string; count?: number }[]; current: string }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} className={`tab${t.to === current ? " tab-active" : ""}`} aria-current={t.to === current ? "page" : undefined}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="tab-count">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Tabs that switch a filter rather than a page. */
export function Segments<V extends string>({ options, value, onChange, label }: { options: { value: V; label: string; count?: number }[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`tab${o.value === value ? " tab-active" : ""}`} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="tab-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- states
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner spinner-lg" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <Icon name="warning" size={20} />
      <p className="state-title">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry} icon="refresh">
          Try again
        </Button>
      )}
    </div>
  );
}

/** Loading, error and empty handling around a loaded list or record. */
export function Async<T>({ load, empty, isEmpty, children, loadingLabel }: { load: Loaded<T>; empty?: ReactNode; isEmpty?: (data: T) => boolean; children: (data: T) => ReactNode; loadingLabel?: string }) {
  if (load.loading) return <Loading label={loadingLabel} />;
  if (load.data === undefined) return <ErrorBox message={load.error ?? "Could not load this."} onRetry={() => void load.reload()} />;
  const none = isEmpty ? isEmpty(load.data) : Array.isArray(load.data) && load.data.length === 0;
  return (
    <>
      {load.error && <Notice tone="error">{load.error}</Notice>}
      {none && empty ? empty : children(load.data)}
    </>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "ok" | "warn" | "error"; children: ReactNode; title?: string }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "warning"} size={16} />
      <div>
        {title && <strong className="notice-title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tables
export interface Column<R> {
  header: string;
  cell: (row: R) => ReactNode;
  /** Right-align numbers. */
  num?: boolean;
  /** The cell that becomes the card title on a phone. */
  primary?: boolean;
  /** Buttons: shown without a label on a phone, at the bottom of the card. */
  actions?: boolean;
  /** The status chip: shown at the top right of the card on a phone. */
  status?: boolean;
  /** Leave the cell out of the phone card when this returns true. */
  hideIfEmpty?: (row: R) => boolean;
  width?: string;
}

/** A table on wide screens; one card per row on a phone (`scroll` keeps it a table that scrolls sideways). */
export function DataTable<R>({
  columns,
  rows,
  rowKey,
  scroll,
  caption,
  detail,
}: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  scroll?: boolean;
  caption?: string;
  /** Extra content shown directly under a row (for "Show details"); return null for rows that are closed. */
  detail?: (row: R) => ReactNode;
}) {
  return (
    <div className={scroll ? "table-scroll" : "table-wrap"}>
      <table className={`table${scroll ? "" : " table-stack"}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className={c.num ? "num" : undefined} style={c.width ? { width: c.width } : undefined}>
                {c.actions ? <span className="sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const extra = detail?.(r);
            return (
              <Fragment key={rowKey(r)}>
                <tr className={extra ? "row-open" : undefined}>
                  {columns.map((c) => {
                    const cls = [c.num ? "num" : "", c.primary ? "cell-primary" : "", c.actions ? "cell-actions" : "", c.status ? "cell-status" : "", c.hideIfEmpty?.(r) ? "cell-empty" : ""].filter(Boolean).join(" ");
                    return (
                      <td key={c.header} data-label={c.header} className={cls || undefined}>
                        {c.cell(r)}
                      </td>
                    );
                  })}
                </tr>
                {extra ? (
                  <tr className="row-detail">
                    <td colSpan={columns.length}>{extra}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- numbers and details
export function Stat({ label, value, to, tone, hint }: { label: string; value: ReactNode; to?: string; tone?: "warn" | "danger"; hint?: string }) {
  const inner = (
    <>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  const cls = `stat${tone ? ` stat-${tone}` : ""}`;
  return to ? (
    <Link to={to} className={`${cls} stat-link`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function KeyValues({ items, columns = 2 }: { items: ([string, ReactNode] | null | false | undefined)[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={`kv kv-${columns}`}>
      {items.map((it) =>
        it ? (
          <div key={it[0]} className="kv-item">
            <dt>{it[0]}</dt>
            <dd>{it[1] === null || it[1] === undefined || it[1] === "" ? "—" : it[1]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

// ---------------------------------------------------------------- form fields
export function Field({ label, hint, error, optional, children, wide }: { label: string; hint?: ReactNode; error?: string | null; optional?: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field${wide ? " field-wide" : ""}`}>
      <span className="field-label">
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/**
 * A password box with a way to see what has been typed. Anyone typing a password they were given on a
 * phone keyboard will mistype it, and a row of dots gives them nothing to check against; the eye is how
 * they check. It starts hidden, so nothing is on screen unless the person asks for it, and the button
 * says which state it is in for a screen reader.
 */
export function PasswordInput({
  value,
  onChange,
  name,
  autoComplete = "current-password",
  autoFocus,
  placeholder,
  required,
  disabled,
  enterKeyHint,
}: {
  value: string;
  onChange: (v: string) => void;
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  enterKeyHint?: "go" | "next" | "done";
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-box">
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        name={name}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        enterKeyHint={enterKeyHint}
        spellCheck={false}
        autoCapitalize="off"
      />
      <button type="button" className="password-eye" onClick={() => setShown((s) => !s)} disabled={disabled} aria-pressed={shown} title={shown ? "Hide the password" : "Show the password"}>
        <Icon name={shown ? "eye-off" : "eye"} size={18} />
        <span className="sr-only">{shown ? "Hide the password" : "Show the password"}</span>
      </button>
    </span>
  );
}

export function Check({ checked, onChange, children, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>
        {children}
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

export function RadioGroup<V extends string>({ legend, options, value, onChange, disabled }: { legend: string; options: { value: V; label: string; help?: string }[]; value: V; onChange: (v: V) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset className="radio-group" disabled={disabled}>
      <legend className="field-label">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="check">
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            {o.help && <span className="hint">{o.help}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function Select({ value, onChange, options, placeholder, disabled, required }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; disabled?: boolean; required?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={required}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A read-only value with a Copy button: a link, a key, a temporary password. */
export function CopyField({ label, value, hint, wide = true }: { label: string; value: string; hint?: ReactNode; wide?: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement("textarea");
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };
  return (
    <div className={`field${wide ? " field-wide" : ""}`}>
      <span className="field-label" id={id}>
        {label}
      </span>
      <div className="copy-row">
        {/* Shown in full and wrapped, so a long link or key can be read as well as copied. */}
        <code className="copy-value mono" aria-labelledby={id}>
          {value}
        </code>
        <Button icon={copied ? "check" : "copy"} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint && <span className="hint">{hint}</span>}
      <span className="sr-only" role="status">
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </div>
  );
}

/** A section that opens on request: a long list of rows, a setting only some people need. */
export function Disclosure({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="disclosure" open={open}>
      <summary>
        <Icon name="chevron" size={16} />
        <span>{summary}</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** A filter control with a small label above it, used in the bar above lists. */
export function Filter({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <label className={`filter${grow ? " filter-grow" : ""}`}>
      <span className="filter-label">{label}</span>
      {children}
    </label>
  );
}
