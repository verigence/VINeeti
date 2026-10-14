// End of day. The day closes in three steps: the booking sheet is read, the stock report is read, and
// the reconciliation is run on the result. The two files are the DMS exports exactly as downloaded.

import { useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { DataSource } from "../components/DataSource";
import { Icon } from "../components/icons";
import { useToast } from "../components/Toast";
import { Async, Button, Card, Chip, CopyField, DataTable, Disclosure, Empty, Field, Notice, PageHeader, RadioGroup, Stat, type Column } from "../components/ui";
import { fmtBytes, fmtDate, fmtDateTime, fmtNumber, fmtWhen, plural, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText, uploadedBy, uploadKind } from "../labels";
import { Link } from "../router";
import { useAlerts, useSession } from "../session";
import type { BookingSummary, DmsUploadResult, EodStatus, EodStep, StockSummary, UploadError, UploadRow } from "../types";

const MAX_BYTES = 12 * 1024 * 1024;

/** A date written in the file name ("stock report as on 05.10.2026.xlsx"), as YYYY-MM-DD. */
function dateInName(name: string): string {
  const m = /(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{4})/.exec(name);
  if (!m) return "";
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}

export function EodPage() {
  const { can, me } = useSession();
  const mayLoad = can("upload.stock") || can("upload.bookings");
  const status = useLoad(() => (can("recon.view") ? api.eodStatus() : Promise.resolve(null)), "eod:status");
  const history = useLoad(() => api.uploads(), "eod:uploads");
  const refresh = () => {
    void status.reload();
    void history.reload();
  };
  const issueLabels = history.data?.issue_labels ?? {};

  return (
    <>
      <PageHeader title="End of day" subtitle={`Read the booking sheet and the stock report, then run the reconciliation. The day ends at ${status.data?.day_end_time ?? me.settings.day_end_time}.`} />
      {/* The status carries the same file dates; re-read after every load so the line never lags behind. */}
      <DataSource key={status.data ? `${status.data.files.stock?.upload_id}:${status.data.files.bookings?.upload_id}` : "none"} status={status.data?.files} />
      {can("recon.view") && (
        <Async load={status} isEmpty={() => false}>
          {(s) => (s ? <StepsCard status={s} onRun={refresh} /> : null)}
        </Async>
      )}
      {mayLoad && (
        <div className="split split-even">
          {can("upload.bookings") && <UploadCard kind="bookings" issueLabels={issueLabels} onDone={refresh} />}
          {can("upload.stock") && <UploadCard kind="stock" issueLabels={issueLabels} onDone={refresh} />}
        </div>
      )}
      <Card title="Files loaded" note="The latest 60 loads." flush>
        <Async load={history} isEmpty={(d) => d.uploads.length === 0} empty={<Empty title="No file has been loaded yet" />}>
          {(d) => <HistoryTable rows={d.uploads} issueLabels={d.issue_labels} />}
        </Async>
      </Card>
      {can("admin.users") && status.data && <FeedCard feed={status.data.feed} reload={status.reload} />}
    </>
  );
}

// ---------------------------------------------------------------- the three steps
function StepsCard({ status, onRun }: { status: EodStatus; onRun: () => void }) {
  const { can } = useSession();
  const action = useAction();
  const run = status.steps.find((s) => s.key === "RECONCILIATION")?.run ?? null;

  const runNow = async () => {
    const res = await action.run(() => api.runRecon(), { success: (r) => `Reconciliation complete: ${plural(r.summary.items.total, "finding")}.` });
    if (res) onRun();
  };

  const detail = (s: EodStep) => {
    if (s.key === "RECONCILIATION") {
      if (!s.run) return "No reconciliation has run yet.";
      const when = `${s.run.by}, ${fmtWhen(s.run.started_at)}`;
      return s.done ? `${when} · ${plural(s.run.open_items, "finding")} open` : `Last run: ${when}, for ${fmtDate(s.run.business_date)}. Not yet run on today's files.`;
    }
    if (!s.load) return "Not read today.";
    return `${s.load.filename ?? "Unnamed file"} · ${plural(s.load.row_count, "row")} · ${s.load.uploaded_by_name ?? "A former user"}, ${fmtWhen(s.load.at)}`;
  };

  return (
    <Card title={`Steps for ${fmtDate(status.business_date)}`} note={`The reconciliation also runs by itself at ${status.day_end_time}.`}>
      <ol className="eod-steps">
        {status.steps.map((s, i) => (
          <li key={s.key} className={`eod-step${s.done ? " eod-done" : ""}`}>
            <span className="step-marker" aria-hidden="true">
              {s.done ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <div className="eod-step-text">
              <p className="strong">
                {s.label} <Chip tone={s.done ? "green" : "amber"}>{s.done ? "Done" : "To do"}</Chip>
              </p>
              <p className="meta">{detail(s)}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="form-actions">
        {can("recon.manage") && (
          <Button variant="primary" icon="refresh" busy={action.busy} onClick={() => void runNow()}>
            Run reconciliation now
          </Button>
        )}
        {run && (
          <Link to={`/recon/${run.id}`} className="btn btn-secondary">
            <span>Open the latest run</span>
          </Link>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- loading a file
interface Loaded {
  result: DmsUploadResult;
  filename: string;
}

function UploadCard({ kind, issueLabels, onDone }: { kind: "stock" | "bookings"; issueLabels: Record<string, string>; onDone: () => void }) {
  const toast = useToast();
  const { reload: refreshBadges } = useAlerts();
  const inputRef = useRef<HTMLInputElement>(null);
  const stock = kind === "stock";
  const [file, setFile] = useState<File | null>(null);
  const [reportDate, setReportDate] = useState("");
  const [mode, setMode] = useState<"COMPLETE" | "PARTIAL">("COMPLETE");
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const busy = step > 0;

  const pick = (f: File | null) => {
    setProblem(null);
    if (f && f.size > MAX_BYTES) {
      setProblem(`This file is ${fmtBytes(f.size)}. The limit is 12 MB.`);
      setFile(null);
      return;
    }
    setFile(f);
    if (f && stock) setReportDate(dateInName(f.name));
  };

  /** Sends the file, and sends it again for as long as the server says there are steps left. */
  const send = async (confirmMissing: boolean) => {
    if (!file) return setProblem("Choose the file first.");
    if (stock && reportDate && reportDate > today()) return setProblem("The report date cannot be in the future.");
    setProblem(null);
    setConfirm(null);
    const opts = stock ? { report_date: reportDate || undefined, mode, confirm_missing: confirmMissing } : {};
    try {
      let n = 1;
      setStep(n);
      let res = await api.uploadDms(kind, file, opts);
      while (res.more) {
        setStep(++n);
        res = await api.uploadDms(kind, file, { ...opts, continue: res.upload_id });
      }
      setLoaded({ result: res, filename: file.name });
      toast.ok(`${file.name} loaded.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onDone();
      void refreshBadges();
    } catch (e) {
      // Many cars the system holds are not in the file: the server asks before marking them as having left stock.
      if (e instanceof ApiError && e.status === 409 && e.code === "CONFIRM_MISSING") setConfirm(e.message);
      else setProblem(errorMessage(e));
    } finally {
      setStep(0);
    }
  };

  return (
    <Card title={stock ? "Stock report" : "Booking sheet"} note={stock ? "The DMS stock report, as exported." : "The DMS booking sheet, as exported."}>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void send(false);
        }}
      >
        <label className="field">
          <span className="field-label">File</span>
          <input ref={inputRef} type="file" accept=".xlsx,.csv" disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          <span className="hint">Excel (.xlsx) or CSV, up to 12 MB.</span>
        </label>
        {stock && (
          <>
            <Field label="Report date" optional hint="The date the report is as on. Left blank, it is taken from the file name, otherwise today.">
              <input type="date" value={reportDate} max={today()} disabled={busy} onChange={(e) => setReportDate(e.target.value)} />
            </Field>
            <RadioGroup
              legend="What is in this file?"
              value={mode}
              onChange={setMode}
              disabled={busy}
              options={[
                { value: "COMPLETE", label: "This file is the dealership's complete stock report", help: "A car the system holds that is not in the file has left stock." },
                { value: "PARTIAL", label: "This file is a partial or filtered export", help: "Only the cars in the file are updated." },
              ]}
            />
          </>
        )}
        {problem && <Notice tone="error">{plainText(problem)}</Notice>}
        {busy && (
          <p className="progress-line" role="status">
            <span className="spinner" aria-hidden="true" />
            {step === 1 ? "Reading the file…" : `Applying… (step ${step})`}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" icon="upload" busy={busy} disabled={!file}>
            {stock ? "Load stock report" : "Load booking sheet"}
          </Button>
        </div>
      </form>
      {loaded && (
        <div className="result" aria-live="polite">
          <h3 className="section-title">Result for {loaded.filename}</h3>
          <LoadResult kind={loaded.result.kind} counts={{ rows: loaded.result.row_count, created: loaded.result.created, updated: loaded.result.updated, unchanged: loaded.result.unchanged }} allocations={loaded.result.allocations} summary={loaded.result.summary} errors={loaded.result.errors} issueLabels={issueLabels} />
        </div>
      )}
      {confirm && <ConfirmDialog title="Cars missing from this file" message={plainText(confirm)} confirmLabel="Confirm and load" danger onCancel={() => setConfirm(null)} onConfirm={() => void send(true)} />}
    </Card>
  );
}

// ---------------------------------------------------------------- what a load did
type AnySummary = Partial<StockSummary & BookingSummary>;

function LoadResult({ kind, counts, allocations, summary, errors, issueLabels }: { kind: string; counts: { rows: number; created: number; updated: number; unchanged: number }; allocations: number; summary: AnySummary; errors: UploadError[]; issueLabels: Record<string, string> }) {
  const s = summary;
  const n = (v: number | undefined) => (v === undefined ? "—" : fmtNumber(v));
  const stock = kind === "STOCK";
  const issues = Object.entries(s.issues ?? {}).filter(([, count]) => count > 0);
  const left = s.left_stock;

  return (
    <div className="load-result">
      <p className="meta">
        {plural(counts.rows, "row")} read · {fmtNumber(counts.created)} new · {fmtNumber(counts.updated)} updated · {fmtNumber(counts.unchanged)} unchanged
      </p>
      <h4 className="result-title">What the file says</h4>
      {stock ? (
        <div className="tiles tiles-compact">
          <Stat label="Cars" value={n(s.cars)} />
          <Stat label="Unallocated" value={n(s.unallocated)} hint={`${n(s.unallocated_received)} received · ${n(s.unallocated_in_transit)} in transit`} />
          <Stat label="Allocated" value={n(s.allocated)} hint={`${n(s.alloted)} Alloted · ${n(s.ibnd)} IBND`} />
          <Stat label="Demo" value={n(s.demo)} />
        </div>
      ) : (
        <div className="tiles tiles-compact">
          <Stat label="Bookings" value={n(s.bookings)} />
          <Stat label="Booked" value={n(s.booked)} />
          <Stat label="Invoiced" value={n(s.invoiced)} />
          <Stat label="Delivered" value={n(s.delivered)} />
          <Stat label="Cancelled" value={n(s.cancelled)} />
        </div>
      )}
      <h4 className="result-title">What changed</h4>
      {stock ? (
        <div className="tiles tiles-compact">
          <Stat label="New cars" value={n(s.new_cars)} />
          <Stat label="Received" value={n(s.received)} />
          <Stat label="Invoiced" value={n(s.invoiced)} />
          <Stat label="Left stock" value={left ? fmtNumber(left.delivered + left.removed + left.on_hold) : "—"} hint={left ? `${fmtNumber(left.delivered)} delivered · ${fmtNumber(left.removed)} removed · ${fmtNumber(left.on_hold)} being checked` : undefined} />
          <Stat label="Links recorded" value={n(s.orders?.recorded)} />
          <Stat label="Links confirmed" value={n(s.orders?.confirmed)} />
          <Stat label="Links bypassed" value={n(s.orders?.bypassed)} tone={s.orders?.bypassed ? "danger" : undefined} />
          <Stat label="Orders known only from stock" value={n(s.orders?.known_only_from_stock)} />
          <Stat label="Cars the system allocated" value={fmtNumber(allocations)} />
        </div>
      ) : (
        <div className="tiles tiles-compact">
          <Stat label="Bookings entered queue" value={n(s.entered_queue)} />
          <Stat label="Cars released by cancellations" value={n(s.cars_released)} />
          <Stat label="Cars the system allocated" value={fmtNumber(allocations)} />
        </div>
      )}
      <dl className="facts">
        <div>
          <dt>Outlets created</dt>
          <dd>{s.outlets_created?.length ? s.outlets_created.join(", ") : "None"}</dd>
        </div>
        <div>
          <dt>Variants added</dt>
          <dd>{n(s.variants_added)}</dd>
        </div>
        {stock && (
          <div>
            <dt>Data issues</dt>
            <dd>
              {issues.length ? (
                <ul className="plain-list">
                  {issues.map(([key, count]) => (
                    <li key={key}>
                      {issueLabels[key] ?? key}: {fmtNumber(count)}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )}
            </dd>
          </div>
        )}
      </dl>
      {errors.length > 0 ? (
        <Disclosure summary={`Rows with errors (${fmtNumber(errors.length)})`}>
          <ErrorsTable errors={errors} keyLabel={stock ? "Chassis (VIN)" : "Booking"} />
        </Disclosure>
      ) : (
        <p className="meta">No row had an error.</p>
      )}
    </div>
  );
}

function ErrorsTable({ errors, keyLabel }: { errors: UploadError[]; keyLabel: string }) {
  const columns: Column<UploadError>[] = [
    { header: keyLabel, primary: true, cell: (e) => <span className="mono">{e.key}</span> },
    { header: "Row", num: true, cell: (e) => e.row, width: "64px" },
    { header: "Problem", cell: (e) => plainText(e.message) },
  ];
  return (
    <div className="boxed-table">
      <DataTable columns={columns} rows={errors} rowKey={(e) => `${e.row}:${e.key}:${e.message}`} caption="Rows with errors" />
    </div>
  );
}

// ---------------------------------------------------------------- history
function HistoryTable({ rows, issueLabels }: { rows: UploadRow[]; issueLabels: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const hasDetail = (u: UploadRow) => u.kind === "STOCK" || u.kind === "BOOKINGS";
  const columns: Column<UploadRow>[] = [
    {
      header: "File",
      primary: true,
      cell: (u) => (
        <>
          <span className="strong">{u.filename ?? "Unnamed file"}</span>
          <span className="sub">{uploadKind(u.kind)}</span>
        </>
      ),
    },
    { header: "Status", status: true, cell: (u) => (u.status === "DONE" ? <Chip tone="green">Loaded</Chip> : u.status === "EMPTY" ? <Chip tone="amber">Nothing loaded</Chip> : <Chip tone="amber">Not finished</Chip>) },
    {
      header: "Loaded",
      cell: (u) => (
        <span>
          <span>{fmtDateTime(u.at)}</span>
          <span className="sub">{uploadedBy(u)}</span>
        </span>
      ),
    },
    { header: "Report date", cell: (u) => (u.report_date ? fmtDate(u.report_date) : <span className="muted">—</span>) },
    { header: "Rows", num: true, cell: (u) => fmtNumber(u.row_count) },
    { header: "New", num: true, cell: (u) => fmtNumber(u.created_count) },
    { header: "Updated", num: true, cell: (u) => fmtNumber(u.updated_count) },
    { header: "Errors", num: true, cell: (u) => (u.error_count ? <Chip tone="red">{fmtNumber(u.error_count)}</Chip> : <span className="muted">0</span>) },
    {
      header: "Details",
      actions: true,
      hideIfEmpty: (u) => !hasDetail(u),
      cell: (u) =>
        hasDetail(u) ? (
          <Button size="sm" variant="ghost" aria-expanded={open === u.id} onClick={() => setOpen(open === u.id ? null : u.id)}>
            {open === u.id ? "Hide result" : "Show result"}
          </Button>
        ) : null,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(u) => u.id}
      caption="Files loaded"
      detail={(u) =>
        u.id === open ? (
          <div className="row-detail-body">
            <LoadResult kind={u.kind} counts={{ rows: u.row_count, created: u.created_count, updated: u.updated_count, unchanged: u.unchanged_count }} allocations={u.allocations} summary={u.summary} errors={u.errors} issueLabels={issueLabels} />
          </div>
        ) : null
      }
    />
  );
}

// ---------------------------------------------------------------- the automatic feed
function FeedCard({ feed, reload }: { feed: EodStatus["feed"]; reload: () => Promise<void> }) {
  const action = useAction();
  const [key, setKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "remove" | null>(null);

  const create = async () => {
    const res = await action.run(() => api.createEodKey(), { quiet: true, success: "End-of-day key created." });
    if (res) {
      setDialog(null);
      await reload();
      setKey(res.key);
    }
  };
  const remove = async () => {
    const res = await action.run(() => api.removeEodKey(), { quiet: true, success: "End-of-day key removed." });
    if (res) {
      setKey(null);
      setDialog(null);
      await reload();
    }
  };

  return (
    <Card title="Automatic end-of-day feed" note="A scheduled job at the dealership can send the two files and ask for the reconciliation, instead of a person loading them here. It proves itself with the end-of-day key.">
      <div className="form-stack">
        <div className="form-grid">
          <CopyField label="Booking sheet is sent to" value={feed.bookings_url} wide={false} />
          <CopyField label="Stock report is sent to" value={feed.stock_url} wide={false} />
          <CopyField label="Reconciliation is asked for at" value={feed.run_url} wide={false} />
        </div>
        <p>{feed.key_set_at ? <>A key was created on {fmtDateTime(feed.key_set_at)}.</> : "No key has been created, so the feed is switched off."}</p>
        {key && (
          <Notice tone="warn" title="Copy the key now. ">
            It will not be shown again.
            <CopyField label="End-of-day key" value={key} />
          </Notice>
        )}
        <div className="form-actions">
          <Button variant="primary" icon="key" disabled={action.busy} onClick={() => (feed.key_set_at ? setDialog("create") : void create())}>
            {feed.key_set_at ? "Create a new key" : "Create key"}
          </Button>
          {feed.key_set_at && (
            <Button variant="danger" disabled={action.busy} onClick={() => setDialog("remove")}>
              Remove key
            </Button>
          )}
        </div>
        {action.error && !dialog && <Notice tone="error">{plainText(action.error)}</Notice>}
      </div>
      {dialog === "create" && (
        <ConfirmDialog title="Create a new end-of-day key?" message="The key in use now stops working at once. The scheduled job has to be given the new key." confirmLabel="Create a new key" busy={action.busy} error={action.error} onCancel={() => setDialog(null)} onConfirm={() => void create()} />
      )}
      {dialog === "remove" && (
        <ConfirmDialog title="Remove the end-of-day key?" message="The scheduled job can no longer send files until a new key is created." confirmLabel="Remove key" danger busy={action.busy} error={action.error} onCancel={() => setDialog(null)} onConfirm={() => void remove()} />
      )}
    </Card>
  );
}
