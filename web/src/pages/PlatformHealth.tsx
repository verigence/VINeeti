// System health, in the platform console: is the deployment up, fast, running its scheduled job, and is
// each dealership's data flowing. Every number is a count the Worker kept about itself (see
// src/lib/health.ts); nothing on this screen is a customer, a booking or a message.
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "../api";
import { Chart } from "../components/Chart";
import { Button, Card, Chip, type Column, DataTable, Empty, KeyValues, Loading, Notice, Stat } from "../components/ui";
import { fmtBytes, fmtDateTime, fmtNumber, fmtTime, fmtWhen } from "../format";
import { platformCall as call } from "../platform-api";

interface Window { label: string; hours: number; requests: number; ok: number; client_errors: number; server_errors: number; error_pct: number | null; avg_ms: number | null; max_ms: number; fast_pct: number | null; slow: number; db_queries: number; db_avg_ms: number | null; db_max_ms: number; db_rows_read: number; db_rows_written: number }
interface Alert { severity: "high" | "medium" | "low"; text: string }
interface Health {
  now: string;
  worker: { version: string | null; deployed_at: string | null; version_first_seen_at: string | null; boot_id: string; booted_at: string; isolates_last_hour: number; cold_starts_24h: number; colos_24h: { colo: string; isolates: number; requests: number }[] };
  windows: Window[];
  series: { at: string; requests: number; server_errors: number; client_errors: number; avg_ms: number | null; db_queries: number }[];
  groups: { group: string; requests: number; server_errors: number; client_errors: number; avg_ms: number | null; max_ms: number; slow: number; db_queries: number; db_rows_read: number; db_rows_written: number }[];
  cron: { expected_every_min: number; last_run_at: string | null; last_duration_ms: number | null; last_ok: boolean | null; minutes_since_last: number | null; runs_24h: number; failed_24h: number; missed_24h: number; avg_duration_ms: number | null; max_duration_ms: number; recent: { started_at: string; duration_ms: number; ok: boolean; tenants: number; errors: number; report: { tenant: string; error?: string; [k: string]: unknown }[] }[] };
  errors: { hour: string; source: string; route: string | null; status: number | null; code: string | null; message: string; count: number; first_at: string; last_at: string }[];
  database: { size_bytes: number | null; size_at: string | null; migration: string | null; tables: { table: string; rows: number }[]; rows_read_24h: number; rows_written_24h: number };
  tenants: { slug: string; name: string; is_active: boolean; timezone: string; stock: { report_date: string | null; loaded_at: string | null; age_days: number | null }; bookings: { report_date: string | null; loaded_at: string | null; age_days: number | null }; expected_every_days: number; stale: boolean; uploads_running: number; uploads_7d: number; upload_error_rows_7d: number; last_recon_date: string | null; last_recon_finished: boolean | null; open_recon_items: number; whatsapp: { provider: string | null; enabled: boolean; queued: number; stuck: number; failed_24h: number; sent_24h: number }; locked_users: number; open_alarms: number }[];
  alerts: Alert[];
  basis: string;
}

const GROUP_LABELS: Record<string, string> = {
  auth: "Sign-in and session",
  eod: "End of day and file feed",
  stock: "Stock and availability",
  bookings: "Bookings and allocation",
  ops: "Dashboards, reports, WhatsApp screens",
  master: "Vehicle master and settings",
  platform: "Platform console",
  webhook: "WhatsApp webhook",
  cron: "Scheduled job",
  assets: "Web app files",
  other: "Other",
};

const REFRESH_MS = 60_000;
const ms = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const pctText = (n: number | null) => (n === null ? "—" : `${n}%`);
const ageText = (f: { report_date: string | null; age_days: number | null }) => (f.report_date === null ? "never loaded" : f.age_days === 0 ? "today" : `${f.age_days} day${f.age_days === 1 ? "" : "s"} old`);

export function PlatformHealthPage() {
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await call<Health>("GET", "/api/platform/health"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
    // Refreshes itself once a minute while the tab is visible; a page left open all day is not a cost.
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const chart = useMemo(() => {
    if (!data) return null;
    const labels = data.series.map((p) => fmtTime(p.at));
    return {
      tooltip: { trigger: "axis" },
      legend: { bottom: 0 },
      grid: { left: 8, right: 16, top: 12, bottom: 44, containLabel: true },
      xAxis: { type: "category", data: labels, axisLabel: { color: "#5b6672", interval: Math.max(0, Math.floor(labels.length / 8) - 1) }, axisTick: { show: false } },
      yAxis: [
        { type: "value", minInterval: 1, name: "requests", axisLabel: { color: "#5b6672" }, splitLine: { lineStyle: { color: "#e9eff3" } } },
        { type: "value", name: "ms", axisLabel: { color: "#5b6672" }, splitLine: { show: false } },
      ],
      series: [
        { name: "Requests", type: "bar", data: data.series.map((p) => p.requests), itemStyle: { color: "#0098a8" }, barMaxWidth: 14 },
        { name: "Server errors", type: "bar", data: data.series.map((p) => p.server_errors), itemStyle: { color: "#9a2a20" }, barMaxWidth: 14 },
        { name: "Time to answer (avg)", type: "line", yAxisIndex: 1, data: data.series.map((p) => p.avg_ms), itemStyle: { color: "#002858" }, lineStyle: { width: 2 }, symbol: "none", smooth: true },
      ],
    };
  }, [data]);

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <Loading label="Reading the deployment" />;

  const [hour, day, week] = data.windows;
  const c = data.cron;
  const cronTone = c.last_run_at === null ? "warn" : !c.last_ok || (c.minutes_since_last ?? 0) > c.expected_every_min * 2 ? "danger" : undefined;
  const errTone = (w: Window) => ((w.error_pct ?? 0) >= 2 ? "danger" : (w.error_pct ?? 0) >= 1 ? "warn" : undefined);

  const groupColumns: Column<Health["groups"][number]>[] = [
    { header: "Part of the system", primary: true, cell: (g) => (<><span className="strong">{GROUP_LABELS[g.group] ?? g.group}</span><span className="sub">{g.group}</span></>) },
    { header: "Requests", num: true, cell: (g) => fmtNumber(g.requests) },
    { header: "4xx", num: true, cell: (g) => fmtNumber(g.client_errors) },
    { header: "5xx", num: true, cell: (g) => (g.server_errors ? <Chip tone="red">{fmtNumber(g.server_errors)}</Chip> : "0") },
    { header: "Avg", num: true, cell: (g) => ms(g.avg_ms) },
    { header: "Slowest", num: true, cell: (g) => ms(g.max_ms) },
    { header: "Over 2 s", num: true, cell: (g) => fmtNumber(g.slow) },
    { header: "DB queries", num: true, cell: (g) => fmtNumber(g.db_queries) },
    { header: "Rows read", num: true, cell: (g) => fmtNumber(g.db_rows_read) },
    { header: "Rows written", num: true, cell: (g) => fmtNumber(g.db_rows_written) },
  ];

  const tenantColumns: Column<Health["tenants"][number]>[] = [
    { header: "Dealership", primary: true, cell: (t) => (<><span className="strong">{t.name}</span><span className="sub">{t.slug}{t.is_active ? "" : " · switched off"}</span></>) },
    { header: "Stock report", cell: (t) => <span className={t.stale && (t.stock.age_days ?? Infinity) > t.expected_every_days ? "danger" : undefined}>{ageText(t.stock)}</span> },
    { header: "Booking sheet", cell: (t) => <span className={t.stale && (t.bookings.age_days ?? Infinity) > t.expected_every_days ? "danger" : undefined}>{ageText(t.bookings)}</span> },
    { header: "Files, 7 days", num: true, cell: (t) => (<>{fmtNumber(t.uploads_7d)}{t.upload_error_rows_7d ? <span className="sub">{fmtNumber(t.upload_error_rows_7d)} rows refused</span> : null}</>) },
    { header: "Last reconciliation", cell: (t) => (t.last_recon_date ? (<>{t.last_recon_date}{t.last_recon_finished === false ? <span className="sub danger">did not finish</span> : t.open_recon_items ? <span className="sub">{fmtNumber(t.open_recon_items)} open</span> : null}</>) : <span className="muted">none yet</span>) },
    { header: "WhatsApp", cell: (t) => (t.whatsapp.provider === null ? <span className="muted">not set up</span> : (<>{t.whatsapp.provider === "META" ? "Meta" : "Test"}{t.whatsapp.enabled ? "" : ", off"} · {fmtNumber(t.whatsapp.sent_24h)} sent{t.whatsapp.failed_24h ? `, ${fmtNumber(t.whatsapp.failed_24h)} failed` : ""}{t.whatsapp.queued ? <span className={`sub${t.whatsapp.stuck ? " danger" : ""}`}>{fmtNumber(t.whatsapp.queued)} queued{t.whatsapp.stuck ? `, ${fmtNumber(t.whatsapp.stuck)} stuck` : ""}</span> : null}</>)) },
    { header: "Open alarms", num: true, cell: (t) => fmtNumber(t.open_alarms) },
    { header: "State", status: true, cell: (t) => (!t.is_active ? <Chip tone="grey">Off</Chip> : t.uploads_running || t.whatsapp.stuck || t.last_recon_finished === false ? <Chip tone="red">Attention</Chip> : t.stale ? <Chip tone="amber">Files late</Chip> : <Chip tone="green">OK</Chip>) },
  ];

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {data.alerts.length ? (
        <div className="health-alerts">
          {data.alerts.map((a, i) => (
            <Notice key={i} tone={a.severity === "high" ? "error" : a.severity === "medium" ? "warn" : "info"}>{a.text}</Notice>
          ))}
        </div>
      ) : (
        <Notice tone="ok">Nothing needs attention. The job is running, requests are being answered, and every dealership's files are within the agreed age.</Notice>
      )}

      <div className="tiles">
        <Stat label="Requests, last hour" value={fmtNumber(hour.requests)} hint={`${fmtNumber(day.requests)} in 24 h`} />
        <Stat label="Server errors, last hour" value={pctText(hour.error_pct)} tone={errTone(hour)} hint={`${fmtNumber(hour.server_errors)} of ${fmtNumber(hour.requests)}; ${pctText(day.error_pct)} in 24 h`} />
        <Stat label="Time to answer, last hour" value={ms(hour.avg_ms)} tone={(hour.avg_ms ?? 0) >= 1500 ? "warn" : undefined} hint={`slowest ${ms(hour.max_ms)}; ${pctText(hour.fast_pct)} under 200 ms`} />
        <Stat label="Scheduled job" value={c.last_run_at ? fmtWhen(c.last_run_at) : "not yet"} tone={cronTone} hint={c.last_run_at ? `${c.runs_24h} runs in 24 h${c.missed_24h ? `, ${c.missed_24h} missed` : ""}${c.failed_24h ? `, ${c.failed_24h} failed` : ""}` : `due every ${c.expected_every_min} min`} />
      </div>

      <Card title="Last 24 hours" note="Requests and server errors in 15-minute steps, with the average time to answer.">
        {data.series.length ? <Chart option={chart!} height={240} /> : <Empty title="No requests counted yet" hint="The first minute is written a minute after the Worker starts answering." />}
      </Card>

      <Card title="Traffic and database, by period" flush>
        <DataTable
          columns={[
            { header: "Period", primary: true, cell: (w: Window) => w.label },
            { header: "Requests", num: true, cell: (w: Window) => fmtNumber(w.requests) },
            { header: "4xx", num: true, cell: (w: Window) => fmtNumber(w.client_errors) },
            { header: "5xx", num: true, cell: (w: Window) => (w.server_errors ? <Chip tone="red">{fmtNumber(w.server_errors)} ({pctText(w.error_pct)})</Chip> : "0") },
            { header: "Avg", num: true, cell: (w: Window) => ms(w.avg_ms) },
            { header: "Slowest", num: true, cell: (w: Window) => ms(w.max_ms) },
            { header: "Over 2 s", num: true, cell: (w: Window) => fmtNumber(w.slow) },
            { header: "DB queries", num: true, cell: (w: Window) => fmtNumber(w.db_queries) },
            { header: "DB avg", num: true, cell: (w: Window) => (w.db_avg_ms === null ? "—" : `${w.db_avg_ms} ms`) },
            { header: "DB slowest", num: true, cell: (w: Window) => ms(w.db_max_ms) },
            { header: "Rows read", num: true, cell: (w: Window) => fmtNumber(w.db_rows_read) },
            { header: "Rows written", num: true, cell: (w: Window) => fmtNumber(w.db_rows_written) },
          ]}
          rows={[hour, day, week]}
          rowKey={(w) => w.label}
          scroll
          caption="Traffic by period"
        />
      </Card>

      <Card title="By part of the system, last 24 hours" flush>
        {data.groups.length ? <DataTable columns={groupColumns} rows={data.groups} rowKey={(g) => g.group} scroll caption="Traffic by route group" /> : <Empty title="Nothing yet" />}
      </Card>

      <div className="health-two">
        <Card title="Scheduled job" note={`Due every ${c.expected_every_min} minutes: payment windows, holds, repairs, allocation, day-end reconciliation, WhatsApp sending.`}>
          <KeyValues
            columns={2}
            items={[
              ["Last run", c.last_run_at ? `${fmtDateTime(c.last_run_at)}${c.minutes_since_last !== null ? ` (${c.minutes_since_last} min ago)` : ""}` : "not recorded yet"],
              ["Last result", c.last_ok === null ? "—" : c.last_ok ? <Chip tone="green">OK</Chip> : <Chip tone="red">Failed</Chip>],
              ["Runs in 24 h", `${fmtNumber(c.runs_24h)} of ${Math.round((24 * 60) / c.expected_every_min)} expected`],
              ["Missed in 24 h", c.missed_24h ? <span className="danger">{fmtNumber(c.missed_24h)}</span> : "0"],
              ["Failed in 24 h", c.failed_24h ? <span className="danger">{fmtNumber(c.failed_24h)}</span> : "0"],
              ["Duration", `${ms(c.last_duration_ms)} last; ${ms(c.avg_duration_ms)} avg; ${ms(c.max_duration_ms)} longest`],
            ]}
          />
          {c.recent.length > 0 && (
            <details className="health-details">
              <summary>Last {c.recent.length} runs</summary>
              <DataTable
                columns={[
                  { header: "Started", primary: true, cell: (r: Health["cron"]["recent"][number]) => fmtDateTime(r.started_at) },
                  { header: "Took", num: true, cell: (r: Health["cron"]["recent"][number]) => ms(r.duration_ms) },
                  { header: "Dealerships", num: true, cell: (r: Health["cron"]["recent"][number]) => r.tenants },
                  { header: "Result", status: true, cell: (r: Health["cron"]["recent"][number]) => (r.ok ? <Chip tone="green">OK</Chip> : <Chip tone="red">{r.errors} failed</Chip>) },
                  { header: "What it did", cell: (r: Health["cron"]["recent"][number]) => <span className="mono" style={{ whiteSpace: "normal" }}>{r.report.map((x) => `${x.tenant}: ${Object.entries(x).filter(([k, v]) => k !== "tenant" && v !== undefined && v !== 0 && v !== null).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing due"}`).join(" · ")}</span> },
                ]}
                rows={c.recent}
                rowKey={(r) => r.started_at}
                scroll
                caption="Recent scheduled runs"
              />
            </details>
          )}
        </Card>

        <Card title="Worker and database">
          <KeyValues
            columns={2}
            items={[
              ["Version deployed", data.worker.version ? <span className="mono">{data.worker.version}</span> : "not stamped"],
              ["Deployed at", data.worker.deployed_at ? fmtDateTime(data.worker.deployed_at) : "—"],
              ["Isolates in the last hour", fmtNumber(data.worker.isolates_last_hour)],
              ["Cold starts in 24 h", fmtNumber(data.worker.cold_starts_24h)],
              ["Locations, 24 h", data.worker.colos_24h.length ? data.worker.colos_24h.map((x) => `${x.colo} (${fmtNumber(x.requests)})`).join(", ") : "—"],
              ["This isolate started", fmtWhen(data.worker.booted_at)],
              ["Database size", data.database.size_bytes === null ? "not reported yet" : `${fmtBytes(data.database.size_bytes)} (as of ${fmtWhen(data.database.size_at)})`],
              ["Latest migration", data.database.migration ? <span className="mono">{data.database.migration}</span> : "—"],
              ["Rows read, 24 h", fmtNumber(data.database.rows_read_24h)],
              ["Rows written, 24 h", fmtNumber(data.database.rows_written_24h)],
            ]}
          />
          <details className="health-details">
            <summary>Rows per table</summary>
            <DataTable
              columns={[
                { header: "Table", primary: true, cell: (t: { table: string; rows: number }) => <span className="mono">{t.table}</span> },
                { header: "Rows", num: true, cell: (t: { table: string; rows: number }) => fmtNumber(t.rows) },
              ]}
              rows={data.database.tables}
              rowKey={(t) => t.table}
              scroll
              caption="Rows per table"
            />
          </details>
        </Card>
      </div>

      <Card title="Each dealership's data" note="Is the DMS data arriving, is the evening reconciliation finishing, and are messages going out. Counts only." flush>
        {data.tenants.length ? <DataTable columns={tenantColumns} rows={data.tenants} rowKey={(t) => t.slug} scroll caption="Dealership health" /> : <Empty title="No dealership yet" />}
      </Card>

      <Card title="Failures" note="Requests the Worker answered with a server error, and scheduled steps that failed. The same failure within an hour is one line with a count." flush>
        {data.errors.length ? (
          <DataTable
            columns={[
              { header: "Last seen", primary: true, cell: (e: Health["errors"][number]) => fmtDateTime(e.last_at) },
              { header: "Times", num: true, cell: (e: Health["errors"][number]) => fmtNumber(e.count) },
              { header: "Where", cell: (e: Health["errors"][number]) => <span className="mono">{e.source === "CRON" ? e.route ?? "scheduled" : e.route ?? "—"}</span> },
              { header: "Status", cell: (e: Health["errors"][number]) => (e.status ? `${e.status}${e.code ? ` ${e.code}` : ""}` : e.code ?? "—") },
              { header: "Message", cell: (e: Health["errors"][number]) => e.message },
            ]}
            rows={data.errors}
            rowKey={(e) => `${e.hour}|${e.route}|${e.message}`}
            scroll
            caption="Failures"
          />
        ) : (
          <Empty title="No failures recorded" hint="Covers the last 30 days." />
        )}
      </Card>

      <div className="health-foot">
        <p className="muted">{data.basis}</p>
        <div className="health-foot-actions">
          <span className="muted">As of {fmtWhen(data.now)}; refreshes every minute.</span>
          <Button size="sm" onClick={() => void load()} busy={busy}>Refresh now</Button>
        </div>
      </div>
    </>
  );
}
