// Settings → Day-end report: whether the report is emailed, when, and to whom; a look at any day's
// report; and a test send to oneself. The report itself is built on the server, the same page that is
// emailed.

import { useState } from "react";
import { api } from "../api";
import { Async, Button, Card, Check, Field, Notice } from "../components/ui";
import { fmtDate, fmtDateTime, today } from "../format";
import { useAction, useLoad } from "../hooks";
import { plainText } from "../labels";
import { useSession } from "../session";
import type { DayEndReportSettings, DayEndSetup, Role } from "../types";

/** Ticks side by side, wrapping on a narrow screen. */
const WRAP = { display: "flex", flexWrap: "wrap", gap: "2px 24px" } as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATUS: Record<string, string> = {
  SENT: "Sent",
  PARTLY_SENT: "Sent to some; others failed",
  FAILED: "Failed",
  NO_RECIPIENTS: "Nobody to send to",
  MAIL_NOT_CONFIGURED: "No mail account set up",
};

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
  const [date, setDate] = useState(today());
  const roles = Object.entries(me.role_labels) as [Role, string][];
  const set = <K extends keyof DayEndReportSettings>(k: K, v: DayEndReportSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const day_end_report = {
      ...s,
      emails: emails
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean),
    };
    const res = await action.run(() => api.saveSettings({ day_end_report }), {
      success: day_end_report.enabled ? `Saved. The report goes out at ${s.time} on the days ticked.` : "Saved. The report is not being sent.",
    });
    if (res) await reload();
  };
  const test = () =>
    action.run(() => api.dayEndTest(date), {
      success: (r) => `Sent to ${r.sent_to.join(", ")}.`,
    });

  return (
    <div className="form-stack">
      <Card
        title="Day-end report"
        note="A one-page summary of the day, in numbers: who signed in, the DMS files loaded, requests raised and decided by outlet and segment, and allocations made outside VINeeti. No customer is named and no money is shown."
      >
        <div className="form-stack">
          {!data.mail_ready && <Notice tone="warn">This deployment has no mail account set up, so the report cannot be emailed. It can still be read here.</Notice>}
          <Check checked={s.enabled} onChange={(v) => set("enabled", v)} hint="Untick to stop sending. Nothing else changes, and it can be turned on again at any time.">
            Email the day-end report
          </Check>
          <Field label="Send at" hint="The dealership's time. The report covers the day up to that moment.">
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
            <span className="hint">Each active person in a ticked role receives it at the email address on their account.</span>
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
          <div>
            <Button variant="primary" busy={action.busy} onClick={() => void save()}>
              Save
            </Button>
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

      <Card title="See a day's report">
        <div className="form-stack">
          <Field label="Day">
            <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
          </Field>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <a className="btn btn-secondary" href={`/api/reports/day-end?date=${encodeURIComponent(date)}`} target="_blank" rel="noopener">
              Open the report
            </a>
            <Button disabled={!data.mail_ready} busy={action.busy} onClick={() => void test()} title={data.mail_ready ? "Emails this day's report to you only" : "No mail account is set up"}>
              Email it to me
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Sent lately">
        {data.history.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Result</th>
                  <th className="num">Recipients</th>
                  <th>At</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.business_date}>
                    <td>{fmtDate(h.business_date)}</td>
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
        ) : (
          <p className="muted">No report has been sent yet.</p>
        )}
      </Card>
    </div>
  );
}
