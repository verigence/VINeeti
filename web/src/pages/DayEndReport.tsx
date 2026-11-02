// The day-end report, in two places.
//
//   Reports → Day-end report   any day's report on screen, and sending it on demand: to everyone it goes
//                              to, or to oneself. For the roles it goes to and whoever configures it.
//   Settings → Day-end report  whether the morning email goes, when, on which days, and to whom.
//
// The report itself is built on the server: the page shown here is the page that is emailed.

import { useState } from "react";
import { api } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { Async, Button, Card, Check, Field, Notice } from "../components/ui";
import { fmtDate, fmtDateTime, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { Link } from "../router";
import { useSession } from "../session";
import type { DayEndReportSettings, DayEndSetup, Role, SentReport } from "../types";

/** Ticks side by side, wrapping on a narrow screen. */
const WRAP = { display: "flex", flexWrap: "wrap", gap: "2px 24px" } as const;
const ROW = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" } as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATUS: Record<string, string> = {
  SENT: "Sent",
  PARTLY_SENT: "Sent to some; others failed",
  FAILED: "Failed",
  NO_RECIPIENTS: "Nobody to send to",
  MAIL_NOT_CONFIGURED: "No mail account set up",
};
const yesterday = () => new Date(Date.parse(`${today()}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function SentTable({ history }: { history: SentReport[] }) {
  if (!history.length) return <p className="muted">No report has been sent yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Report for</th>
            <th>How</th>
            <th>Result</th>
            <th className="num">Recipients</th>
            <th>Sent at</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h, i) => (
            <tr key={`${h.sent_at}-${i}`}>
              <td>{fmtDate(h.business_date)}</td>
              <td>
                {h.how}
                {h.by ? ` by ${h.by}` : ""}
              </td>
              <td>
                {STATUS[h.status] ?? h.status}
                {h.attempts > 1 ? ` (${h.attempts} attempts)` : ""}
              </td>
              <td className="num">{h.recipients}</td>
              <td>{fmtDateTime(h.sent_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Reports → Day-end report
export function DayEndReportView() {
  const action = useAction();
  const sent = useLoad(() => api.dayEndSent(), "day-end:sent");
  const [date, setDate] = useState(yesterday());
  const [confirm, setConfirm] = useState(false);
  const src = `/api/reports/day-end?date=${encodeURIComponent(date)}`;

  const send = async (to?: "me") => {
    const res = await action.run(() => api.dayEndSend(date, to), {
      quiet: !to,
      success: (r) => `Sent to ${r.sent_to.length === 1 ? r.sent_to[0] : `${r.sent_to.length} people`}${r.failed.length ? `; ${r.failed.length} could not be sent` : ""}.`,
    });
    if (res) {
      setConfirm(false);
      await sent.reload();
    }
  };

  return (
    <div className="form-stack">
      <Card title="Day-end report" note="Every morning the previous day's report is emailed to the people it is set up for. Any day can be read here and sent again.">
        <div style={ROW}>
          <Field label="Day">
            <input type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ maxWidth: 200 }} />
          </Field>
          <Button variant="primary" busy={action.busy} onClick={() => setConfirm(true)}>
            Email to all recipients
          </Button>
          <Button busy={action.busy} onClick={() => void send("me")}>
            Email it to me
          </Button>
          <a className="btn btn-secondary" href={src} target="_blank" rel="noopener">
            Open in a new tab
          </a>
        </div>
        {action.error && !confirm && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="error">{plainText(action.error)}</Notice>
          </div>
        )}
      </Card>
      <iframe title={`Day-end report for ${fmtDate(date)}`} src={src} style={{ width: "100%", height: 1400, border: "1px solid #dfe6ec", borderRadius: 8, background: "#fff" }} />
      <Card title="Sent lately">
        <Async load={sent} isEmpty={() => false}>
          {(d) => <SentTable history={d.history} />}
        </Async>
      </Card>
      {confirm && (
        <ConfirmDialog
          title={`Email the report for ${fmtDate(date)}?`}
          message={`It goes now to everyone who receives the morning email${sent.data ? ` (${sent.data.recipients} ${sent.data.recipients === 1 ? "person" : "people"})` : ""}.`}
          confirmLabel="Send now"
          busy={action.busy}
          error={plainText(action.error) || null}
          onConfirm={() => void send()}
          onCancel={() => {
            action.clearError();
            setConfirm(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Settings → Day-end report
export function DayEndReportTab() {
  const load = useLoad(() => api.dayEndSetup(), "admin:day-end");
  return (
    <Async load={load} isEmpty={() => false}>
      {(d) => <DayEndForm key={JSON.stringify(d.settings)} data={d} reload={load.reload} />}
    </Async>
  );
}

function DayEndForm({ data, reload }: { data: DayEndSetup; reload: () => Promise<void> }) {
  const { me } = useSession();
  const action = useAction();
  const [s, setS] = useState<DayEndReportSettings>(data.settings);
  const [emails, setEmails] = useState(data.settings.emails.join("\n"));
  const roles = Object.entries(me.role_labels) as [Role, string][];
  const set = <K extends keyof DayEndReportSettings>(k: K, v: DayEndReportSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const day_end_report = { ...s, emails: emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean) };
    const res = await action.run(() => api.saveSettings({ day_end_report }), {
      success: day_end_report.enabled ? `Saved. The previous day's report goes out at ${s.time} on the days ticked.` : "Saved. The morning email is stopped.",
    });
    if (res) await reload();
  };

  return (
    <div className="form-stack">
      <Card
        title="Day-end report"
        note="Every morning, the previous day in numbers: who signed in and when, the DMS files loaded, requests raised and decided by outlet and segment, and allocations made outside VINeeti. No customer is named and no money is shown."
      >
        <div className="form-stack">
          {!data.mail_ready && <Notice tone="warn">This deployment has no mail account set up, so the report cannot be emailed. It can still be read under Reports.</Notice>}
          <Check checked={s.enabled} onChange={(v) => set("enabled", v)} hint="Untick to stop the morning email. The report can still be read and sent from Reports.">
            Email the day-end report every morning
          </Check>
          <Field label="Send at" hint="The dealership's time (IST). The email carries the previous day's report, midnight to midnight.">
            <input type="time" value={s.time} onChange={(e) => set("time", e.target.value)} style={{ maxWidth: 160 }} />
          </Field>
          <fieldset className="radio-group">
            <legend className="field-label">On these days</legend>
            <div style={WRAP}>
              {WEEKDAYS.map((d, i) => (
                <Check key={d} checked={s.days.includes(i)} onChange={(on) => set("days", on ? [...new Set([...s.days, i])].sort() : s.days.filter((x) => x !== i))}>
                  {d}
                </Check>
              ))}
            </div>
          </fieldset>
          <fieldset className="radio-group">
            <legend className="field-label">To the people in these roles</legend>
            <span className="hint">Each active person in a ticked role receives it at the email address on their account, and can read it and send it from Reports.</span>
            <div style={WRAP}>
              {roles.map(([r, label]) => (
                <Check key={r} checked={s.roles.includes(r)} onChange={(on) => set("roles", on ? [...new Set([...s.roles, r])] : s.roles.filter((x) => x !== r))}>
                  {label}
                </Check>
              ))}
            </div>
          </fieldset>
          <Field label="And to these addresses" optional hint="One per line. For someone who has no account here.">
            <textarea rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@example.com" />
          </Field>
          {action.error && <Notice tone="error">{plainText(action.error)}</Notice>}
          <div style={ROW}>
            <Button variant="primary" busy={action.busy} onClick={() => void save()}>
              Save
            </Button>
            <Link to="/analytics/day-end" className="btn btn-secondary">
              See or send a report
            </Link>
          </div>
        </div>
      </Card>

      <Card title="Who receives it now" note="As saved. Save first to see the effect of a change.">
        {data.recipients.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {data.recipients.map((r) => (
                  <tr key={r.email}>
                    <td>{r.name || "—"}</td>
                    <td>{r.role}</td>
                    <td>{r.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Nobody: no active person in the chosen roles has an email address, and no further address is given.</p>
        )}
        {data.without_email.length > 0 && (
          <Notice tone="warn" title="Not sent to: ">
            {data.without_email.map((p) => `${p.name} (${p.role})`).join(", ")} — no email address on their account.
          </Notice>
        )}
      </Card>

      <Card title="Sent lately">
        <SentTable history={data.history} />
      </Card>
    </div>
  );
}
