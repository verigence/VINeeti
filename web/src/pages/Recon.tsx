import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { Icon } from "../components/icons";
import { Async, Button, Card, Chip, DataTable, Empty, PageHeader, Stat, StatusChip, type Column } from "../components/ui";
import { fmtDate, fmtDateTime, fmtNumber, plural } from "../format";
import { useAction, useLoad } from "../hooks";
import { humanize, plainText, reconItemStatus, severity, SEVERITY_TITLES } from "../labels";
import { Link, useRouter } from "../router";
import { useSession } from "../session";
import type { ReconItem, ReconRunDetail, ReconRunRow, ReconSummary } from "../types";

const runBy = (r: { trigger: string; run_by?: string | null }) => (r.trigger === "SCHEDULED" ? "Automatic, at day end" : `Run by ${r.run_by ?? "a user"}`);

export function ReconPage() {
  const { can, me } = useSession();
  const { navigate } = useRouter();
  const load = useLoad(() => api.reconRuns(), "recon:runs");
  const action = useAction();

  const runNow = async () => {
    const res = await action.run(() => api.runRecon(), { success: (r) => `The day-end check is done: ${plural(r.summary.items.total, "finding")}.` });
    if (res) navigate(`/recon/${res.run_id}`);
  };

  const columns: Column<ReconRunRow>[] = [
    {
      header: "Business date",
      primary: true,
      cell: (r) => (
        <Link to={`/recon/${r.id}`} className="cell-link">
          <span className="strong">{fmtDate(r.business_date)}</span>
          <span className="sub">{runBy(r)}</span>
        </Link>
      ),
    },
    { header: "Run at", cell: (r) => fmtDateTime(r.started_at) },
    { header: "Findings", num: true, cell: (r) => fmtNumber(r.items?.total ?? 0) },
    {
      header: "By severity",
      cell: (r) =>
        r.items?.total ? (
          <span className="chips">
            {r.items.high > 0 && <Chip tone="red">{r.items.high} high</Chip>}
            {r.items.medium > 0 && <Chip tone="amber">{r.items.medium} medium</Chip>}
            {r.items.low > 0 && <Chip tone="grey">{r.items.low} low</Chip>}
          </span>
        ) : (
          <Chip tone="green">All clear</Chip>
        ),
    },
    { header: "Still open", num: true, cell: (r) => (r.open_items ? <span className="strong">{fmtNumber(r.open_items)}</span> : <span className="muted">0</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Differences to settle"
        subtitle={`Checks that stock, bookings and allocations agree, and lists every difference for someone to resolve. Runs automatically at ${me.settings.day_end_time} every day.`}
        primary={
          can("recon.manage") ? (
            <Button variant="primary" icon="refresh" busy={action.busy} onClick={() => void runNow()}>
              Run now
            </Button>
          ) : undefined
        }
      />
      <Card flush>
        <Async load={load} empty={<Empty title="No day-end check has run yet" hint={can("recon.manage") ? "Run it now to check today's position." : "The first run happens at day end."} />}>
          {(rows) => <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Day-end runs" />}
        </Async>
      </Card>
    </>
  );
}

export function ReconDetailPage({ id }: { id: string }) {
  const load = useLoad(() => api.reconRun(id), `recon:${id}`);
  return (
    <Async load={load} isEmpty={() => false} loadingLabel="Loading the day-end check">
      {(run) => <RunView run={run} reload={load.reload} />}
    </Async>
  );
}

type StockRow = ReconSummary["stock"][number];

function RunView({ run, reload }: { run: ReconRunDetail; reload: () => Promise<void> }) {
  const { can } = useSession();
  const action = useAction();
  const [closing, setClosing] = useState<ReconItem | null>(null);
  const s = run.summary;
  const open = run.items.filter((i) => i.status === "OPEN").length;

  const stockColumns: Column<StockRow>[] = [
    { header: "Outlet", primary: true, cell: (r) => <span className="strong">{r.outlet}</span> },
    { header: "Opening", num: true, cell: (r) => fmtNumber(r.opening) },
    { header: "Added", num: true, cell: (r) => fmtNumber(r.added) },
    { header: "Left", num: true, cell: (r) => fmtNumber(r.left) },
    { header: "Closing", num: true, cell: (r) => <span className="strong">{fmtNumber(r.closing)}</span> },
    { header: "Expected closing", num: true, cell: (r) => (r.expected_closing === r.closing ? fmtNumber(r.expected_closing) : <span className="strong danger">{fmtNumber(r.expected_closing)} (differs)</span>) },
    { header: "In transit", num: true, cell: (r) => fmtNumber(r.in_transit) },
    { header: "Free in yard", num: true, cell: (r) => fmtNumber(r.in_yard_free) },
    { header: "Allocated in yard", num: true, cell: (r) => fmtNumber(r.in_yard_allocated) },
    { header: "Blocked", num: true, cell: (r) => fmtNumber(r.blocked) },
  ];

  return (
    <>
      <PageHeader
        back={{ to: "/recon", label: "Differences to settle" }}
        title={`Differences found for ${fmtDate(run.business_date)}`}
        subtitle={`${run.trigger === "SCHEDULED" ? "Automatic, at day end" : "Run on request"} · ${fmtDateTime(run.started_at)}`}
        actions={
          <a className="btn btn-secondary" href={api.reconCsvUrl(run.id)} download>
            <Icon name="download" size={16} />
            <span>Download CSV</span>
          </a>
        }
      />

      <Card title="Stock position by outlet" note="Opening stock plus cars added, less cars that left, should equal closing stock." flush>
        {s.stock?.length ? <DataTable columns={stockColumns} rows={s.stock} rowKey={(r) => r.outlet_id} caption="Stock position by outlet" /> : <Empty title="No stock figures were recorded for this run" />}
      </Card>

      <div className="split split-even">
        <Card title="Bookings">
          {s.bookings ? (
            <div className="tiles tiles-compact">
              <Stat label="Waiting for a car" value={fmtNumber(s.bookings.waiting)} />
              <Stat label="On hold" value={fmtNumber(s.bookings.on_hold)} />
              <Stat label="Allocated" value={fmtNumber(s.bookings.allocated)} />
              <Stat label="Waiting for approval" value={fmtNumber(s.bookings.awaiting_approval)} />
              <Stat label="Invoiced that day" value={fmtNumber(s.bookings.invoiced_today)} />
              <Stat label="Delivered that day" value={fmtNumber(s.bookings.delivered_today)} />
              <Stat label="Cancelled that day" value={fmtNumber(s.bookings.cancelled_today)} />
            </div>
          ) : (
            <Empty title="No booking figures were recorded" />
          )}
        </Card>
        <Card title="The day's activity">
          {s.day ? (
            <div className="tiles tiles-compact">
              <Stat label="Cars allocated" value={fmtNumber(s.day.allocations)} />
              <Stat label="Cars released" value={fmtNumber(s.day.releases)} />
              <Stat label="Cars received" value={fmtNumber(s.day.received)} />
              <Stat label="Payment reminders" value={fmtNumber(s.day.reminders)} />
              <Stat label="Escalations" value={fmtNumber(s.day.escalations)} />
              <Stat label="Requests decided" value={fmtNumber(s.day.exceptions_decided)} />
              <Stat label="Messages sent" value={fmtNumber(s.day.messages_sent)} />
              <Stat label="Messages failed" value={fmtNumber(s.day.messages_failed)} tone={s.day.messages_failed ? "danger" : undefined} />
              <Stat label="Files loaded" value={fmtNumber(s.day.uploads)} />
            </div>
          ) : (
            <Empty title="No activity figures were recorded" />
          )}
        </Card>
      </div>

      <Card title={`Findings (${run.items.length})`} note={run.items.length ? `${open} still open. The reconciliation reports differences; it never changes data on its own.` : undefined}>
        {run.items.length === 0 ? (
          <Empty title="No differences found" hint="Stock, bookings and allocations agree for this day." />
        ) : (
          (["HIGH", "MEDIUM", "LOW"] as const).map((sev) => {
            const items = run.items.filter((i) => i.severity === sev);
            if (!items.length) return null;
            return (
              <section key={sev} className="finding-group">
                <h3 className="section-title">
                  <StatusChip label={severity(sev)} /> {SEVERITY_TITLES[sev]} ({items.length})
                </h3>
                <ul className="finding-list">
                  {items.map((i) => (
                    <FindingItem key={i.id} item={i} category={run.categories[i.category] ?? humanize(i.category)} onClose={can("recon.manage") ? () => setClosing(i) : undefined} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </Card>

      {closing && (
        <ConfirmDialog
          title="Close this finding?"
          message={plainText(closing.message)}
          confirmLabel="Close finding"
          reason="required"
          reasonLabel="Note"
          reasonHint="Say what was checked or corrected. The note stays on the record."
          busy={action.busy}
          error={action.error}
          onCancel={() => {
            action.clearError();
            setClosing(null);
          }}
          onConfirm={async (note) => {
            const res = await action.run(() => api.resolveReconItem(closing.id, note), { quiet: true, success: "Finding closed." });
            if (res) {
              setClosing(null);
              await reload();
            }
          }}
        />
      )}
    </>
  );
}

function FindingItem({ item: i, category, onClose }: { item: ReconItem; category: string; onClose?: () => void }) {
  const { can } = useSession();
  const link =
    i.entity_id && i.entity_type === "booking" && can("booking.view")
      ? { to: `/bookings/${i.entity_id}`, label: "Open booking" }
      : i.entity_id && i.entity_type === "vehicle" && can("stock.view")
        ? { to: `/stock/cars/${i.entity_id}`, label: "Open car" }
        : null;
  return (
    <li className={`finding${i.status === "RESOLVED" ? " finding-closed" : ""}`}>
      <div className="finding-main">
        <p className="finding-category">
          {category}
          {i.outlet ? <span className="muted"> · {i.outlet}</span> : null}
        </p>
        <p>{plainText(i.message)}</p>
        {i.status === "RESOLVED" && (
          <p className="meta">
            Closed by {i.resolved_by_name ?? "a user"} on {fmtDateTime(i.resolved_at)}: {i.resolution_note}
          </p>
        )}
      </div>
      <div className="finding-side">
        <StatusChip label={reconItemStatus(i.status)} />
        {link && (
          <Link to={link.to} className="btn btn-ghost btn-sm">
            <span>{link.label}</span>
          </Link>
        )}
        {i.status === "OPEN" && onClose && (
          <Button size="sm" onClick={onClose}>
            Close with a note
          </Button>
        )}
      </div>
    </li>
  );
}
