// End of day. The day closes in three steps: the booking sheet is read, the stock report is read, and
// the reconciliation is run on the result. The two files are the DMS exports exactly as downloaded.

import { useRef, useState } from "react";
import { api, ApiError, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { DataSource } from "../components/DataSource";
import { Icon } from "../components/icons";
import { useToast } from "../components/Toast";
import { Async, Button, Card, Chip, CopyField, DataTable, Disclosure, Empty, Field, Notice, PageHeader, RadioGroup, Stat, type Column } from "../components/ui";
import { fmtBytes, fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtWhen, plural, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText, uploadedBy, uploadKind } from "../labels";
import { Link } from "../router";
import { useAlerts, useSession } from "../session";
import type { BookingSummary, DmsUploadResult, EodStatus, EodStep, RetailSummary, StockSummary, SyncState, UploadError, UploadRow } from "../types";

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
      <PageHeader title="Upload DMS files" subtitle={`Read the booking sheet, the stock report and the retail export, then run the reconciliation. The day ends at ${status.data?.day_end_time ?? me.settings.day_end_time}.`} />
      {/*
        Before the next file goes in: what this system has decided that the DMS has not been told
        about, and whether anybody has so much as taken the sheet away since the last file.
        Deliberately not a block. Nothing here can make a person key a row into the DMS, and a
        warning that stops the day's work gets worked around rather than heeded. What it can do is
        say so plainly, with the list one click away.
      */}
      {status.data?.sync && status.data.sync.pending > 0 && (
        <Notice tone={status.data.sync.downloaded_since_upload ? "info" : "warn"}>
          {status.data.sync.downloaded_since_upload ? (
            <>
              {plural(status.data.sync.pending, "allocation decision")} still not showing in the DMS. The update sheet was taken on {fmtDateTime(status.data.sync.downloaded_at ?? "")}
              {status.data.sync.downloaded_by ? ` by ${status.data.sync.downloaded_by}` : ""}, so somebody has it. Until a stock report comes back showing the DMS agreeing, they stay on the list.{" "}
              <Link to="/analytics/writeback">Open the list</Link>
            </>
          ) : (
            <>
              {plural(status.data.sync.pending, "allocation decision")} — {fmtNumber(status.data.sync.allot)} to allot, {fmtNumber(status.data.sync.remove)} to remove — have not been put into the DMS,
              and nobody has downloaded the update sheet since the last file was loaded. Loading today's files will not erase them, but every day they are not keyed in is a day the two systems disagree
              about who has which car. <Link to="/analytics/writeback">Take the sheet first</Link>
            </>
          )}
        </Notice>
      )}

      {can("dashboards.view") && status.data?.sync && <DmsSheetCard sync={status.data.sync} />}

      {/* The status carries the same file dates; re-read after every load so the line never lags behind. */}
      <DataSource key={status.data ? `${status.data.files.stock?.upload_id}:${status.data.files.bookings?.upload_id}` : "none"} status={status.data?.files} />
      {can("recon.view") && (
        <Async load={status} isEmpty={() => false}>
          {(s) => (s ? <StepsCard status={s} onRun={refresh} /> : null)}
        </Async>
      )}
      {mayLoad && (
        <div className="split split-three">
          {can("upload.bookings") && <UploadCard kind="bookings" issueLabels={issueLabels} onDone={refresh} />}
          {can("upload.stock") && <UploadCard kind="stock" issueLabels={issueLabels} onDone={refresh} />}
          {can("upload.bookings") && <UploadCard kind="retail" issueLabels={issueLabels} onDone={refresh} />}
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

// ---------------------------------------------------------------- the sheet that goes the other way
/**
 * The exchange with the DMS runs both ways and now sits on one screen: the sheet of decisions goes
 * out from here, the three files come back in here. It used to be a tab of Reports and nothing else,
 * which is a long way to walk for the one output the rest of this system exists to produce -- and a
 * person who does not know the tab is there has no way to find out that anything is waiting.
 *
 * The card is shown whether or not anything is pending. An empty one says the DMS agrees, which is
 * worth knowing; a card that appears only when there is work is a card nobody learns the place of.
 */
function DmsSheetCard({ sync }: { sync: SyncState }) {
  return (
    <Card
      title="Sheet for the DMS"
      note="Allocation is decided here. This is the list of decisions the DMS has not been told about yet, as a sheet to key in."
      actions={
        <a className="btn btn-primary btn-sm" href={api.dmsWritebackUrl} download>
          Download as Excel
        </a>
      }
    >
      {sync.pending > 0 ? (
        <>
          <div className="tiles tiles-compact">
            <Stat label="To allot in the DMS" value={fmtNumber(sync.allot)} />
            <Stat label="To remove in the DMS" value={fmtNumber(sync.remove)} />
          </div>
          <p className="muted">
            {sync.downloaded_since_upload
              ? `Taken on ${fmtDateTime(sync.downloaded_at ?? "")}${sync.downloaded_by ? ` by ${sync.downloaded_by}` : ""}. A line goes from the list when a stock report comes back showing the DMS agreeing, so nothing has to be ticked off by hand.`
              : "Nobody has taken the sheet since the last file was loaded."}{" "}
            <Link to="/analytics/writeback">See the list, car by car</Link>
          </p>
        </>
      ) : (
        <p className="muted">
          Nothing is waiting. The DMS agrees with this system about every car. <Link to="/analytics/writeback">Open the list</Link>
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- the three steps
function StepsCard({ status, onRun }: { status: EodStatus; onRun: () => void }) {
  const { can } = useSession();
  const action = useAction();
  const run = status.steps.find((s) => s.key === "RECONCILIATION")?.run ?? null;

  const runNow = async () => {
    const res = await action.run(() => api.runRecon(), { success: (r) => `The day-end check is done: ${plural(r.summary.items.total, "finding")}.` });
    if (res) onRun();
  };

  const detail = (s: EodStep) => {
    if (s.key === "RECONCILIATION") {
      if (!s.run) return "No day-end check has run yet.";
      const when = `${s.run.by}, ${fmtWhen(s.run.started_at)}`;
      return s.done ? `${when} · ${plural(s.run.open_items, "finding")} open` : `Last run: ${when}, for ${fmtDate(s.run.business_date)}. Not yet run on today's files.`;
    }
    if (!s.load) return "Not read today.";
    return `${s.load.filename ?? "Unnamed file"} · ${plural(s.load.row_count, "row")} · ${s.load.uploaded_by_name ?? "A former user"}, ${fmtWhen(s.load.at)}`;
  };

  return (
    <Card title={`Steps for ${fmtDate(status.business_date)}`} note={`The check also runs by itself at ${status.day_end_time}.`}>
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
            Run the day-end check now
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

function UploadCard({ kind, issueLabels, onDone }: { kind: "stock" | "bookings" | "retail"; issueLabels: Record<string, string>; onDone: () => void }) {
  const toast = useToast();
  const { reload: refreshBadges } = useAlerts();
  const inputRef = useRef<HTMLInputElement>(null);
  const stock = kind === "stock";
  // The retail export is dated like the stock report but describes a period rather than a position,
  // so it takes a report date and never the complete-or-partial question.
  const dated = kind !== "bookings";
  const WORDS = {
    stock: { title: "Stock report", note: "The DMS stock report, as exported.", button: "Load stock report" },
    bookings: { title: "Booking sheet", note: "The DMS booking sheet, as exported.", button: "Load booking sheet" },
    retail: { title: "Retail export", note: "The DMS retail invoice export. What the dealership earned: discounts, what the manufacturer owes back, finance, insurance and the delivery note.", button: "Load retail export" },
  } as const;
  const words = WORDS[kind];
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
    if (f && dated) setReportDate(dateInName(f.name));
  };

  /** Sends the file, and sends it again for as long as the server says there are steps left. */
  const send = async (confirmMissing: boolean) => {
    if (!file) return setProblem("Choose the file first.");
    if (dated && reportDate && reportDate > today()) return setProblem("The report date cannot be in the future.");
    setProblem(null);
    setConfirm(null);
    const opts = stock ? { report_date: reportDate || undefined, mode, confirm_missing: confirmMissing } : dated ? { report_date: reportDate || undefined } : {};
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
    <Card title={words.title} note={words.note}>
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
        {dated && (
          <Field label="Report date" optional hint="The date the file is as on. Left blank, it is taken from the file name, otherwise today.">
            <input type="date" value={reportDate} max={today()} disabled={busy} onChange={(e) => setReportDate(e.target.value)} />
          </Field>
        )}
        {stock && (
          <>
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
            {words.button}
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
type AnySummary = Partial<Omit<StockSummary & BookingSummary & RetailSummary, "issues">> & { issues?: Record<string, number> };

function LoadResult({ kind, counts, allocations, summary, errors, issueLabels }: { kind: string; counts: { rows: number; created: number; updated: number; unchanged: number }; allocations: number; summary: AnySummary; errors: UploadError[]; issueLabels: Record<string, string> }) {
  const s = summary;
  const n = (v: number | undefined) => (v === undefined ? "—" : fmtNumber(v));
  const stock = kind === "STOCK";
  const retail = kind === "RETAIL";
  const money = (v: number | undefined) => (v === undefined ? "—" : fmtMoney(v));
  const issues = Object.entries(s.issues ?? {}).filter(([, count]) => count > 0);
  const left = s.left_stock;

  return (
    <div className="load-result">
      <p className="meta">
        {plural(counts.rows, "row")} read · {fmtNumber(counts.created)} new · {fmtNumber(counts.updated)} updated · {fmtNumber(counts.unchanged)} unchanged
      </p>
      <h4 className="result-title">What the file says</h4>
      {retail ? (
        <div className="tiles tiles-compact">
          <Stat label="Invoices" value={n(s.invoices?.total)} />
          <Stat label="Invoiced" value={money(s.money?.invoiced)} hint={`${money(s.money?.selling)} before tax`} />
          <Stat label="Given away on the manufacturer's schemes" value={money(s.money?.oem_discount)} hint={`and ${money(s.money?.dealer_discount)} of the dealership's own margin`} />
          <Stat
            label="Not claimed back"
            value={money(s.money?.unclaimed_discount)}
            hint="Discount given with no credit note recorded against it"
            tone={s.money?.unclaimed_discount ? "danger" : undefined}
          />
        </div>
      ) : stock ? (
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
      {retail ? (
        <div className="tiles tiles-compact">
          <Stat label="New invoices" value={n(s.invoices?.new)} />
          <Stat label="Changed" value={n(s.invoices?.changed)} />
          <Stat label="Withdrawn" value={n(s.invoices?.withdrawn)} hint="Listed before, not in this file" tone={s.invoices?.withdrawn ? "danger" : undefined} />
          <Stat label="Financed" value={n(s.attached?.financed)} hint={`${n(s.attached?.dealer_arranged)} arranged by the dealership`} />
          <Stat label="Insured" value={n(s.attached?.insured)} />
          <Stat label="Taken away" value={n(s.attached?.delivered)} hint="A delivery note is recorded" />
        </div>
      ) : stock ? (
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
          {s.not_keyed_in && s.not_keyed_in.cars > 0 && (
            <Stat
              label="Still not keyed into the DMS"
              value={fmtNumber(s.not_keyed_in.cars)}
              hint={`Allocated before the last report and still not in this one — oldest ${plural(s.not_keyed_in.oldest_days ?? 0, "day")}`}
              tone="danger"
            />
          )}
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
        {!retail && (
          <div>
            <dt>Variants added</dt>
            <dd>{n(s.variants_added)}</dd>
          </div>
        )}
        {retail && (
          <div>
            <dt>Claims the file does not state</dt>
            <dd>
              {s.claims_not_stated?.length
                ? `${s.claims_not_stated.join(", ")} — blank on every row, so nothing was read from the blanks.`
                : "None: every claim column the file uses is filled somewhere."}
            </dd>
          </div>
        )}
        {(stock || retail) && (
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
          <ErrorsTable errors={errors} keyLabel={stock ? "Chassis (VIN)" : retail ? "Invoice" : "Booking"} />
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
  const hasDetail = (u: UploadRow) => u.kind === "STOCK" || u.kind === "BOOKINGS" || u.kind === "RETAIL";
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
          <CopyField label="The day-end check is asked for at" value={feed.run_url} wide={false} />
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
