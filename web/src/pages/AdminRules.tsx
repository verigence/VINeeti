// Rules and settings of the dealership: who gets which car, the payment window, who approves, who is
// alarmed, and what the system expects of the DMS files. A change to the allocation rules is previewed
// against the bookings waiting now before it is saved.

import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/icons";
import { ActionBar, Async, Button, Card, Check, Field, Notice, RadioGroup, Select } from "../components/ui";
import { fmtDate, fmtNumber, plural } from "../format";
import { useAction, useLoad } from "../hooks";
import { CHECKLIST_ITEMS, OUTLET_SCOPE_OPTIONS, plainText, vehicleStatus } from "../labels";
import { useSession } from "../session";
import type { CarCriterion, ChecklistKey, CriterionInfo, OutletScope, PreviewCar, QueueCriterion, Role, RulesPreview, SettingsResponse, TenantSettings } from "../types";

export function RulesTab() {
  const load = useLoad(() => api.settings(), "admin:settings");
  return (
    <Async load={load} isEmpty={() => false}>
      {(data) => <RulesForm key={JSON.stringify(data.settings)} data={data} reload={load.reload} />}
    </Async>
  );
}

/** The settings that decide which booking gets which car: a change to any of them is previewed first. */
const PREVIEWED: (keyof TenantSettings)[] = ["queue_order", "car_order", "outlet_scope", "nearby_outlets", "allocate_in_transit"];

/** A list of rules applied in the order shown: move up, move down, remove, add. */
function OrderedRules<K extends string>({ legend, hint, value, all, onChange, tail }: { legend: string; hint: string; value: K[]; all: Record<K, CriterionInfo>; onChange: (v: K[]) => void; tail: string }) {
  const unused = (Object.keys(all) as K[]).filter((k) => !value.includes(k));
  const move = (i: number, by: number) => {
    const next = [...value];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <fieldset className="ordered">
      <legend className="field-label">{legend}</legend>
      <span className="hint">{hint}</span>
      <ol className="ordered-list">
        {value.map((k, i) => (
          <li key={k} className="ordered-item">
            <span className="ordered-no" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ordered-text">
              <span className="strong">{all[k]?.label ?? k}</span>
              <span className="hint">{all[k]?.help}</span>
            </span>
            <span className="ordered-buttons">
              <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${all[k]?.label ?? k} up`}>
                <Icon name="up" />
              </button>
              <button type="button" className="icon-btn" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${all[k]?.label ?? k} down`}>
                <Icon name="down" />
              </button>
              <button type="button" className="icon-btn" disabled={value.length === 1} onClick={() => onChange(value.filter((x) => x !== k))} aria-label={`Remove ${all[k]?.label ?? k}`}>
                <Icon name="close" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      <span className="hint">{tail}</span>
      {unused.length > 0 && (
        <Field label="Add a rule">
          <Select value="" onChange={(v) => v && onChange([...value, v as K])} options={unused.map((k) => ({ value: k, label: all[k].label }))} placeholder="Choose a rule to add" />
        </Field>
      )}
    </fieldset>
  );
}

/** For "own outlet, then nearby": the outlets whose spare cars may serve each outlet, in order of preference. */
function NearbyOutlets({ value, onChange }: { value: Record<string, string[]>; onChange: (v: Record<string, string[]>) => void }) {
  const { me } = useSession();
  const outlets = me.all_outlets;
  const name = (id: string) => outlets.find((o) => o.id === id)?.name ?? "An outlet no longer in use";
  const set = (outlet: string, list: string[]) => {
    const next = { ...value };
    if (list.length) next[outlet] = list;
    else delete next[outlet];
    onChange(next);
  };
  return (
    <fieldset className="ordered">
      <legend className="field-label">Nearby outlets</legend>
      <span className="hint">For each outlet, the outlets whose free cars may serve its bookings, in order of preference.</span>
      <ul className="nearby-list">
        {outlets.map((o) => {
          const list = value[o.id] ?? [];
          const options = outlets.filter((x) => x.id !== o.id && !list.includes(x.id)).map((x) => ({ value: x.id, label: x.name }));
          return (
            <li key={o.id} className="nearby-item">
              <span className="strong">{o.name}</span>
              {list.length ? (
                <ol className="ordered-list">
                  {list.map((id, i) => (
                    <li key={id} className="ordered-item">
                      <span className="ordered-no" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="ordered-text">{name(id)}</span>
                      <span className="ordered-buttons">
                        <button type="button" className="icon-btn" disabled={i === 0} onClick={() => set(o.id, [...list.slice(0, i - 1), id, list[i - 1], ...list.slice(i + 1)])} aria-label={`Move ${name(id)} up for ${o.name}`}>
                          <Icon name="up" />
                        </button>
                        <button type="button" className="icon-btn" onClick={() => set(o.id, list.filter((x) => x !== id))} aria-label={`Remove ${name(id)} from ${o.name}`}>
                          <Icon name="close" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="hint">No nearby outlet: only its own cars serve it.</span>
              )}
              {options.length > 0 && <Select value="" onChange={(v) => v && set(o.id, [...list, v])} options={options} placeholder={`Add a nearby outlet for ${o.name}`} />}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function RoleChecks({ legend, hint, roles, value, onChange }: { legend: string; hint: ReactNode; roles: [Role, string][]; value: Role[]; onChange: (v: Role[]) => void }) {
  return (
    <fieldset className="radio-group">
      <legend className="field-label">{legend}</legend>
      <span className="hint">{hint}</span>
      {roles.map(([r, label]) => (
        <Check key={r} checked={value.includes(r)} onChange={(on) => onChange(on ? [...new Set([...value, r])] : value.filter((x) => x !== r))}>
          {label}
        </Check>
      ))}
    </fieldset>
  );
}

function RulesForm({ data, reload }: { data: SettingsResponse; reload: () => Promise<void> }) {
  const { me, can, refresh } = useSession();
  const action = useAction();
  const editable = can("admin.settings");
  const isAdmin = me.user.role === "ADMIN";
  const [s, setS] = useState<TenantSettings>(data.settings);
  // Optional numbers are typed as text so that an empty box means "not set".
  const [fundingRate, setFundingRate] = useState(data.settings.funding_rate_pct === null ? "" : String(data.settings.funding_rate_pct));
  const [monthTarget, setMonthTarget] = useState(data.settings.monthly_retail_target === null ? "" : String(data.settings.monthly_retail_target));
  const [transitDays, setTransitDays] = useState(data.settings.transit_days === null ? "" : String(data.settings.transit_days));
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ patch: Partial<TenantSettings>; result: RulesPreview } | null>(null);
  const roles = Object.entries(data.role_labels) as [Role, string][];
  const set = <K extends keyof TenantSettings>(key: K, value: TenantSettings[K]) => setS((cur) => ({ ...cur, [key]: value }));
  const int = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const num = (v: number) => (Number.isNaN(v) ? "" : v);

  const edited: TenantSettings = { ...s, funding_rate_pct: fundingRate.trim() === "" ? null : Number(fundingRate), transit_days: transitDays.trim() === "" ? null : Number(transitDays), monthly_retail_target: monthTarget.trim() === "" ? null : Number(monthTarget) };
  /** Only what was changed is sent, so a setting somebody else may not change is never touched. */
  const patch = (): Partial<TenantSettings> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(edited) as (keyof TenantSettings)[]) if (JSON.stringify(edited[k]) !== JSON.stringify(data.settings[k])) out[k] = edited[k];
    return out as Partial<TenantSettings>;
  };
  const dirty = Object.keys(patch()).length > 0;
  const rulesChanged = PREVIEWED.some((k) => k in patch());

  const check = (): string | null => {
    for (const k of ["reminder_days", "escalation_days", "reallocate_days", "approval_sla_hours", "data_stale_days", "payment_verify_hours"] as const) {
      if (!Number.isInteger(s[k]) || s[k] < 1) return "Days and hours must be whole numbers of 1 or more.";
    }
    if (!(s.reminder_days < s.escalation_days && s.escalation_days < s.reallocate_days)) return "The days must increase: reminder first, then escalation, then re-allocation.";
    if (!Number.isFinite(s.min_booking_amount) || s.min_booking_amount < 0) return "The minimum booking amount must be zero or more.";
    if (s.business_hours_from >= s.business_hours_to) return "Business hours must start before they end.";
    if (!s.booking_approver_roles.length || !s.exception_approver_roles.length || !s.alarm_roles.length) return "Choose at least one role to approve bookings, one to approve exceptions and one to receive alarms.";
    if (fundingRate.trim() !== "" && !(Number(fundingRate) > 0 && Number(fundingRate) <= 40)) return "The funding rate must be a percentage between 0 and 40, or left blank.";
    if (monthTarget.trim() !== "" && !(Number.isInteger(Number(monthTarget)) && Number(monthTarget) >= 1)) return "The monthly target must be a whole number of cars, or left blank.";
    if (transitDays.trim() !== "" && !(Number.isInteger(Number(transitDays)) && Number(transitDays) >= 1 && Number(transitDays) <= 90)) return "Usual transit days must be a whole number between 1 and 90, or left blank.";
    return null;
  };

  const save = async (p: Partial<TenantSettings>) => {
    const res = await action.run(() => api.saveSettings(p), { quiet: true, success: (r) => (r.rules_changed.length ? "Settings saved. The new allocation rules apply from now on; the people who receive alarms have been told." : "Settings saved.") });
    if (res) {
      setPreview(null);
      await Promise.all([reload(), refresh()]);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editable || action.busy) return;
    const bad = check();
    if (bad) return setProblem(bad);
    setProblem(null);
    const p = patch();
    if (!rulesChanged) return save(p);
    // Allocation rules: show what they would do to the bookings waiting now, before anything is saved.
    const result = await action.run(() => api.previewSettings(p), { quiet: true });
    if (result) setPreview({ patch: p, result });
  };

  return (
    <form onSubmit={submit} noValidate className="form-page">
      <fieldset disabled={!editable} className="bare-fieldset">
        <Card title="Allocation rules" note="Who gets which car. A change here is previewed against the bookings waiting now before it is saved, and the people who receive alarms are told.">
          <div className="form-grid">
            <OrderedRules<QueueCriterion> legend="Queue order" hint="Which waiting booking is served first. Rules apply in the order listed; ties fall to the next one." value={s.queue_order} all={data.queue_criteria} onChange={(v) => set("queue_order", v)} tail="Always ends with booking date, then booking number." />
            <OrderedRules<CarCriterion> legend="Car order" hint="Which free car a booking is given. Rules apply in the order listed." value={s.car_order} all={data.car_criteria} onChange={(v) => set("car_order", v)} tail="Always ends with chassis number." />
          </div>
          <RadioGroup legend="Outlet reach" value={s.outlet_scope} onChange={(v) => set("outlet_scope", v as OutletScope)} options={OUTLET_SCOPE_OPTIONS.map((o) => ({ value: o.value, label: o.label, help: o.help }))} />
          {s.outlet_scope === "SAME_OUTLET_NEARBY" && <NearbyOutlets value={s.nearby_outlets} onChange={(v) => set("nearby_outlets", v)} />}
          <div className="form-grid rules-gap">
            <RadioGroup
              legend="Cars in transit"
              value={s.allocate_in_transit ? "yes" : "no"}
              onChange={(v) => set("allocate_in_transit", v === "yes")}
              options={[
                { value: "yes", label: "Allocate cars in transit", help: "A car still on its way is given to the next waiting booking." },
                { value: "no", label: "Allocate only cars at the dealership", help: "A car is given only once it has been received." },
              ]}
            />
            <RadioGroup
              legend="Bookings in the DMS booking sheet"
              value={s.import_bookings_as_approved ? "queue" : "approve"}
              onChange={(v) => set("import_bookings_as_approved", v === "queue")}
              options={[
                { value: "queue", label: "Enter the queue directly", help: "They are confirmed in the DMS, so no approval is asked for here." },
                { value: "approve", label: "Wait for approval first", help: "Each booking appears under Approvals before it joins the queue." },
              ]}
            />
          </div>
        </Card>

        <Card title="Payment window" note="Counted in days from the day the allocated car is at the dealership (day 0).">
          <div className="form-grid form-grid-3">
            <Field label="Reminder day" hint="A WhatsApp payment reminder goes to the customer.">
              <input type="number" min={1} max={60} step={1} value={num(s.reminder_days)} onChange={(e) => set("reminder_days", int(e.target.value))} inputMode="numeric" />
            </Field>
            <Field label="Escalation day" hint="An alarm is raised that payment is still pending.">
              <input type="number" min={1} max={60} step={1} value={num(s.escalation_days)} onChange={(e) => set("escalation_days", int(e.target.value))} inputMode="numeric" />
            </Field>
            <Field label="Re-allocation day" hint="The car is released and goes to the next customer in the queue.">
              <input type="number" min={1} max={90} step={1} value={num(s.reallocate_days)} onChange={(e) => set("reallocate_days", int(e.target.value))} inputMode="numeric" />
            </Field>
          </div>
          <div className="form-grid rules-gap">
            <RadioGroup
              legend="After a payment timeout, the booking that lost its car"
              value={s.hold_after_timeout ? "hold" : "back"}
              onChange={(v) => set("hold_after_timeout", v === "hold")}
              options={[
                { value: "hold", label: "Goes on hold until staff mark the customer as ready", help: "It keeps its original place in the queue." },
                { value: "back", label: "Goes to the back of the queue" },
              ]}
            />
            <Field label="Time for Finance to verify (hours)" hint="A payment reported by sales and not verified within this time is raised as an alarm.">
              <input type="number" min={1} max={240} step={1} value={num(s.payment_verify_hours)} onChange={(e) => set("payment_verify_hours", int(e.target.value))} inputMode="numeric" />
            </Field>
          </div>
        </Card>

        <Card title="Approvals and alarms">
          <div className="form-grid form-grid-3">
            <RoleChecks legend="Booking approvers" hint="Nobody can approve a booking they created themselves." roles={roles} value={s.booking_approver_roles} onChange={(v) => set("booking_approver_roles", v)} />
            <RoleChecks legend="Exception approvers" hint="Priority changes, skips, deferrals, outlet changes, named cars and extra time to pay." roles={roles} value={s.exception_approver_roles} onChange={(v) => set("exception_approver_roles", v)} />
            <RoleChecks legend="Alarm recipients" hint="Alarms appear in the app for these roles and go to those people on WhatsApp." roles={roles} value={s.alarm_roles} onChange={(v) => set("alarm_roles", v)} />
          </div>
          <div className="form-grid rules-gap">
            <Field label="Approval time limit (hours)" hint="A booking or request waiting longer than this is reported at day end.">
              <input type="number" min={1} max={720} step={1} value={num(s.approval_sla_hours)} onChange={(e) => set("approval_sla_hours", int(e.target.value))} inputMode="numeric" />
            </Field>
          </div>
        </Card>

        <Card title="DMS files and stock">
          <div className="form-grid">
            <Field label="DMS files expected every (days)" hint="When a file is older than this, screens say so and no car is re-allocated automatically.">
              <input type="number" min={1} max={30} step={1} value={num(s.data_stale_days)} onChange={(e) => set("data_stale_days", int(e.target.value))} inputMode="numeric" />
            </Field>
            <Field label="Usual transit days" optional hint="Days a car usually takes from the manufacturer's invoice to arrival. Used only for an indicative arrival date; left blank, no date is shown.">
              <input type="number" min={1} max={90} step={1} value={transitDays} onChange={(e) => setTransitDays(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Annual funding rate (%)" optional hint="The yearly cost of stock funding. Used only for the funding-interest measure; left blank, that measure is not shown.">
              <input type="number" min={0} max={40} step="any" value={fundingRate} onChange={(e) => setFundingRate(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Retails the dealership aims for in a month" optional hint="Used to say whether the month is ahead or behind on the home screen. Left blank, the pace is still shown, without a verdict against it.">
              <input type="number" min={1} step={1} value={monthTarget} onChange={(e) => setMonthTarget(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="DMS dealer name" hint={isAdmin ? "The dealership's name as its DMS files write it. A file for another dealer is refused." : "Set by the first DMS file loaded. Only the system administrator can change it."}>
              <input value={s.dms_dealer_name} onChange={(e) => set("dms_dealer_name", e.target.value)} disabled={!isAdmin} maxLength={120} />
            </Field>
          </div>
        </Card>

        {/* The minimum used to be a rule about this app's own booking form, and it sat with the checklist
            because of that. It is now what decides whether a booking takes a place in the queue at all,
            whichever system the booking came from, so it is its own setting with its own warning: raise
            it above what customers have actually paid and the queue empties. */}
        <Card title="The booking amount and the queue">
          <div className="form-grid">
            <Field
              label="Minimum booking amount (₹)"
              hint="A booking that has not reached this amount takes no place in the queue — it stays on the books and the customer is listed on the sales lead's board so the rest can be collected, but no car is allotted to it. It is only ever applied to a customer who has not already been given a car: a booking that already holds a car is left alone. A booking entered here cannot be submitted below it. Enter 0 for no minimum."
            >
              <input type="number" min={0} step={1} value={num(s.min_booking_amount)} onChange={(e) => set("min_booking_amount", int(e.target.value))} inputMode="numeric" />
            </Field>
            {s.min_booking_amount > 0 && (
              <p className="hint">
                After saving, check <strong>Under the minimum</strong> on Today&apos;s board. That list is everyone this amount has taken out of the queue; if it is longer than expected, the amount is higher than customers here actually pay.
              </p>
            )}
          </div>
        </Card>

        <Card title="Bookings entered here">
          <fieldset className="radio-group">
            <legend className="field-label">Booking checklist</legend>
            <span className="hint">Items the person submitting a booking confirms are on file. Nothing is uploaded.</span>
            {CHECKLIST_ITEMS.map((d) => (
              <Check key={d.key} checked={s.required_documents.includes(d.key)} onChange={(on) => set("required_documents", on ? CHECKLIST_ITEMS.map((x) => x.key).filter((k) => k === d.key || s.required_documents.includes(k)) : s.required_documents.filter((k: ChecklistKey) => k !== d.key))}>
                {d.label}
              </Check>
            ))}
          </fieldset>
        </Card>

        {/* Not a preference. This is the date the dealership stops allotting cars in the DMS by hand,
            and from which doing so is answerable to somebody. */}
        <Card
          title="The system decides who gets a car"
          note="From the date you give, every car is meant to be given out here. An allotment that turns up in the DMS without having come through is reported at day end and put in front of the approvers for taking a car back. Before that date — and while it is empty — the DMS's allotments are taken on as the history of a dealership that was not running on this yet."
        >
          <div className="form-grid form-grid-3">
            <Field label="System controls allocation from" hint="Leave empty until the dealership is ready. Set it to the day you go live, not to today, or the first days' allotments are reported as if somebody had gone round the system.">
              <input type="date" value={s.allocation_control_from ?? ""} onChange={(e) => set("allocation_control_from", e.target.value || null)} />
            </Field>
          </div>
        </Card>

        <Card title="Hours and messages">
          <div className="form-grid form-grid-3">
            <Field label="Business hours start" hint="Customer reminders and escalations are only sent between these times.">
              <input type="time" value={s.business_hours_from} onChange={(e) => set("business_hours_from", e.target.value)} />
            </Field>
            <Field label="Business hours end">
              <input type="time" value={s.business_hours_to} onChange={(e) => set("business_hours_to", e.target.value)} />
            </Field>
            <Field label="Day-end time" hint="The day-end reconciliation runs at this time.">
              <input type="time" value={s.day_end_time} onChange={(e) => set("day_end_time", e.target.value)} />
            </Field>
            <Field label="In-transit arrival text" hint="Used in the in-transit message when a car has no expected arrival date." wide>
              <input value={s.in_transit_eta_text} onChange={(e) => set("in_transit_eta_text", e.target.value)} maxLength={60} />
            </Field>
          </div>
        </Card>
      </fieldset>

      {(problem || (action.error && !preview)) && <Notice tone="error">{problem ?? plainText(action.error)}</Notice>}
      {editable && (
        <ActionBar sticky>
          <Button type="submit" variant="primary" busy={action.busy && !preview} disabled={!dirty}>
            {rulesChanged ? "Preview and save" : "Save settings"}
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty || action.busy}
            onClick={() => {
              setS(data.settings);
              setFundingRate(data.settings.funding_rate_pct === null ? "" : String(data.settings.funding_rate_pct));
              setMonthTarget(data.settings.monthly_retail_target === null ? "" : String(data.settings.monthly_retail_target));
              setTransitDays(data.settings.transit_days === null ? "" : String(data.settings.transit_days));
              setProblem(null);
            }}
          >
            Discard changes
          </Button>
          {dirty && <span className="hint">You have unsaved changes.</span>}
        </ActionBar>
      )}

      {preview && <PreviewDialog preview={preview.result} busy={action.busy} error={plainText(action.error) || null} onClose={() => !action.busy && setPreview(null)} onSave={() => void save(preview.patch)} />}
    </form>
  );
}

const carText = (c: PreviewCar | null) => (c ? `${c.vin} (${vehicleStatus(c.status).text.toLowerCase()}, ${c.outlet})` : "No car");

/** What the proposed rules would do to the bookings waiting now. Nothing is saved until the person confirms. */
function PreviewDialog({ preview: p, busy, error, onClose, onSave }: { preview: RulesPreview; busy: boolean; error: string | null; onClose: () => void; onSave: () => void }) {
  const changed = p.groups.filter((g) => g.changed > 0);
  return (
    <Dialog
      title="What these rules would do"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Go back
          </Button>
          <Button variant="primary" busy={busy} onClick={onSave} data-autofocus="">
            Save rules
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <p>
          <strong>
            {fmtNumber(p.bookings_affected)} of {plural(p.waiting_bookings, "waiting booking")}
          </strong>{" "}
          would change place in the queue or be given a different car. Cars already allocated are not affected.
        </p>
        {changed.length === 0 ? (
          <Notice>No waiting booking changes place or car under these rules.</Notice>
        ) : (
          changed.map((g) => (
            <section key={`${g.model}|${g.variant}|${g.colour}`} className="preview-group">
              <h3 className="preview-title">
                {g.model} {g.variant}, {g.colour}
              </h3>
              <p className="meta">
                {plural(g.waiting, "booking")} waiting · {plural(g.free_cars, "free car")} · {plural(g.changed, "booking")} affected
              </p>
              <ul className="preview-rows">
                {g.rows
                  .filter((r) => r.changed)
                  .map((r) => (
                    <li key={r.booking_no}>
                      <span className="strong">{r.booking_no}</span>
                      <span className="sub">
                        {r.outlet} · booked {fmtDate(r.booking_date)}
                      </span>
                      <span>
                        Place {r.position_now ?? "—"} to {r.position_then ?? "—"}
                      </span>
                      <span className="sub">
                        Now: {carText(r.car_now)}. Then: {carText(r.car_then)}.
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
