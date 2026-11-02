// The day-end report: one page of numbers for the people who run the dealership, sent by email at a time
// the dealership chooses and readable in the app for any date.
//
// What it covers, for one business day (midnight to midnight, the dealership's time):
//   1. Who used the system: sign-ins by role, and each person who signed in.
//   2. The DMS files loaded: when, by whom, and what each said.
//   3. Requests to change an allocation (and to take a car back): raised, approved, rejected, withdrawn,
//      and pending now, by type, and by outlet and segment.
//   4. Allocations: made here, taken on from the DMS, released, and allotments made in the DMS outside
//      this system.
//
// Numbers only. It names staff (who signed in, who loaded a file), never a customer, and carries no
// money, because it goes to more people than the owner's view does.
//
// The HTML is laid out in tables with the styles on the elements, as the other messages are: it has to
// read the same in Outlook, Gmail and a phone. The same page is what the app shows.

import type { Ctx, Role } from "../env";
import { all, first, run } from "../lib/db";
import { MailError, mailer } from "../lib/mailer";
import { ROLE_LABELS } from "../lib/permissions";
export type { DayEndReportSettings } from "../lib/settings";
import { iso, localDayBounds, localParts, newId } from "../lib/util";
import { segmentLabel } from "../oem";
import { emailMark } from "./onboarding";

const EXCEPTION_LABELS: Record<string, string> = {
  PRIORITY_CHANGE: "Change of priority",
  SKIP_ALLOCATION: "Skip allocation",
  DEFER_DELIVERY: "Defer delivery",
  OUTLET_CHANGE: "Change of outlet",
  MANUAL_ALLOCATION: "Manual allocation",
  WINDOW_EXTENSION: "Extend the payment window",
  RELEASE_ALLOCATION: "Take the car back (deallocation)",
  OTHER: "Other request",
};
const OUTSIDE_LABELS: Record<string, string> = {
  REFUSED: "Allotted in the DMS over a car held here (refused)",
  OVERTURNED: "Car held here already sold elsewhere",
  UNKNOWN_BOOKING: "Allotted to a booking never seen here",
  NOT_THROUGH_SYSTEM: "Allotted to a waiting booking without going through the queue",
};
const FILE_LABELS: Record<string, string> = { STOCK: "Stock report", BOOKINGS: "Booking report", RETAIL: "Retail report" };

export interface DayEndData {
  dealership: string;
  oem: string;
  date: string;
  /** Local time the figures were read. */
  prepared_at: string;
  url: string;
  people: {
    signed_in: number;
    /** Each person who signed in, with the times they did. */
    list: { name: string; role: string; times: string[] }[];
  };
  files: { kind: string; label: string; at: string; by: string; report_date: string | null; rows: number; created: number; updated: number; errors: number; brief: string }[];
  last_files: { kind: string; label: string; at: string | null }[];
  requests: {
    raised: number;
    approved: number;
    rejected: number;
    withdrawn: number;
    pending: number;
    overdue: number;
    sla_hours: number;
    by_type: { label: string; raised: number; approved: number; rejected: number; pending: number }[];
    by_place: { outlet: string; segment: string; raised: number; approved: number; rejected: number; pending: number }[];
  };
  allocations: {
    made_here: number;
    from_dms: number;
    released: number;
    outside: number;
    outside_by_kind: { label: string; n: number }[];
    outside_by_place: { outlet: string; segment: string; n: number }[];
  };
}

const at = (iso: string | null | undefined, tz: string) => (iso ? localParts(new Date(iso), tz).time : "");
const num = (v: unknown) => Number(v ?? 0) || 0;
const safe = <T>(json: string | null | undefined, fallback: T): T => {
  try {
    return json ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The address of the deployment, for the link at the foot of the report. */
export function siteUrl(ctx: Ctx): string {
  const host = (ctx.tenant as { hostname?: string | null }).hostname;
  return host ? `https://${host}` : (ctx.env.APP_URL ?? "").trim();
}

/** A booking's segment, as the dealership names it; blank categories read "Not set". */
const SEGMENT_SQL = `COALESCE((SELECT vv.category FROM vehicle_variants vv WHERE vv.tenant_id = b.tenant_id AND vv.model = b.model AND vv.category <> '' LIMIT 1), '')`;

export async function gatherDayEnd(ctx: Ctx, date: string): Promise<DayEndData> {
  const tz = ctx.tenant.timezone;
  const T = ctx.tenantId;
  const { start, end } = localDayBounds(date, tz);
  const segment = (c: string) => (c ? segmentLabel(ctx.tenant.oem, c) : "Not set");
  const label = (r: string) => ROLE_LABELS[r as Role] ?? r;

  // ---- 1. people: who signed in, and when
  const signIns = await all<{ user_id: string; name: string | null; role: string | null; at: string }>(
    ctx.db,
    `SELECT user_id, name, role, at FROM sign_ins WHERE tenant_id = ? AND outcome = 'IN' AND user_id IS NOT NULL AND at >= ? AND at < ? ORDER BY at`,
    T, start, end,
  );
  const perUser = new Map<string, { name: string; role: string; times: string[] }>();
  for (const s of signIns) {
    const cur = perUser.get(s.user_id) ?? { name: s.name ?? "", role: s.role ?? "", times: [] };
    const t = at(s.at, tz);
    if (!cur.times.includes(t)) cur.times.push(t);
    perUser.set(s.user_id, cur);
  }
  const order = Object.keys(ROLE_LABELS);
  const people: DayEndData["people"] = {
    signed_in: perUser.size,
    list: [...perUser.values()]
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, role: label(p.role), times: p.times })),
  };

  // ---- 2. DMS files
  const uploads = await all<{ kind: string; at: string; by: string | null; report_date: string | null; row_count: number; created_count: number; updated_count: number; error_count: number; summary_json: string; status: string }>(
    ctx.db,
    `SELECT u.kind, u.at, us.name AS by, u.report_date, u.row_count, u.created_count, u.updated_count, u.error_count, u.summary_json, u.status
       FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by WHERE u.tenant_id = ? AND u.at >= ? AND u.at < ? ORDER BY u.at`,
    T, start, end,
  );
  const files = uploads.map((u) => {
    const s = safe<Record<string, any>>(u.summary_json, {});
    let brief = "";
    if (u.kind === "STOCK") {
      brief = `${many(num(s.cars), "car")}, ${fmt(num(s.allocated))} allotted in the DMS; ${fmt(num(s.new_cars))} new, ${fmt(num(s.received))} arrived, ${fmt(num(s.left_stock?.delivered) + num(s.left_stock?.removed) + num(s.left_stock?.on_hold))} left stock`;
    } else if (u.kind === "BOOKINGS") {
      brief = `${many(num(s.bookings), "booking")}: ${fmt(num(s.booked))} booked, ${fmt(num(s.invoiced) + num(s.delivered))} invoiced, ${fmt(num(s.cancelled))} cancelled; ${fmt(num(s.new_bookings))} new, ${fmt(num(s.cancelled_now))} cancelled today`;
    } else if (u.kind === "RETAIL") {
      brief = `${many(num(s.invoices?.total), "invoice")}; ${fmt(num(s.invoices?.new))} new, ${fmt(num(s.invoices?.withdrawn))} withdrawn`;
    }
    if (u.status === "RUNNING") brief += " (still being applied)";
    return { kind: u.kind, label: FILE_LABELS[u.kind] ?? u.kind, at: at(u.at, tz), by: u.by ?? "", report_date: u.report_date, rows: num(u.row_count), created: num(u.created_count), updated: num(u.updated_count), errors: num(u.error_count), brief };
  });
  const last = await all<{ kind: string; at: string }>(ctx.db, `SELECT kind, MAX(at) AS at FROM uploads WHERE tenant_id = ? AND status = 'DONE' AND at < ? GROUP BY kind`, T, end);
  const last_files = ["STOCK", "BOOKINGS", "RETAIL"].map((k) => {
    const a = last.find((x) => x.kind === k)?.at ?? null;
    return { kind: k, label: FILE_LABELS[k], at: a ? `${localParts(new Date(a), tz).date} ${at(a, tz)}` : null };
  });

  // ---- 3. requests
  const reqs = await all<{ type: string; status: string; requested_at: string; decided_at: string | null; outlet: string; category: string }>(
    ctx.db,
    `SELECT e.type, e.status, e.requested_at, e.decided_at, COALESCE(o.name, '') AS outlet, ${SEGMENT_SQL} AS category
       FROM exceptions e JOIN bookings b ON b.id = e.booking_id LEFT JOIN outlets o ON o.id = b.outlet_id
      WHERE e.tenant_id = ?1 AND ((e.requested_at >= ?2 AND e.requested_at < ?3) OR (e.decided_at >= ?2 AND e.decided_at < ?3) OR e.status = 'PENDING')`,
    T, start, end,
  );
  const raisedToday = (r: (typeof reqs)[number]) => r.requested_at >= start && r.requested_at < end;
  const decidedToday = (r: (typeof reqs)[number], s: string) => r.status === s && r.decided_at !== null && r.decided_at >= start && r.decided_at < end;
  // Pending as the day closed: raised before its end and not decided by then.
  const pendingAtEnd = (r: (typeof reqs)[number]) => r.requested_at < end && (r.status === "PENDING" || (r.decided_at !== null && r.decided_at >= end));
  const count = (list: typeof reqs) => ({
    raised: list.filter(raisedToday).length,
    approved: list.filter((r) => decidedToday(r, "APPROVED")).length,
    rejected: list.filter((r) => decidedToday(r, "REJECTED")).length,
    pending: list.filter(pendingAtEnd).length,
  });
  const slaCut = new Date(Math.min(Date.parse(end), ctx.now.getTime()) - ctx.settings.approval_sla_hours * 3_600_000).toISOString();
  const byType = Object.keys(EXCEPTION_LABELS)
    .map((t) => ({ label: EXCEPTION_LABELS[t], ...count(reqs.filter((r) => r.type === t)) }))
    .filter((x) => x.raised + x.approved + x.rejected + x.pending > 0);
  const places = new Map<string, typeof reqs>();
  for (const r of reqs) {
    const k = `${r.outlet}\u0000${segment(r.category)}`;
    if (!places.has(k)) places.set(k, []);
    places.get(k)!.push(r);
  }
  const byPlace = [...places.entries()]
    .map(([k, list]) => ({ outlet: k.split("\u0000")[0] || "—", segment: k.split("\u0000")[1], ...count(list) }))
    .filter((x) => x.raised + x.approved + x.rejected + x.pending > 0)
    .sort((a, b) => a.outlet.localeCompare(b.outlet) || a.segment.localeCompare(b.segment));
  const all_ = count(reqs);
  const requests: DayEndData["requests"] = {
    ...all_,
    withdrawn: reqs.filter((r) => decidedToday(r, "WITHDRAWN")).length,
    overdue: reqs.filter((r) => pendingAtEnd(r) && r.requested_at < slaCut).length,
    sla_hours: ctx.settings.approval_sla_hours,
    by_type: byType,
    by_place: byPlace,
  };

  // ---- 4. allocations
  const allocs = await first<{ here: number; dms: number }>(
    ctx.db,
    `SELECT SUM(CASE WHEN source <> 'DMS' THEN 1 ELSE 0 END) AS here, SUM(CASE WHEN source = 'DMS' THEN 1 ELSE 0 END) AS dms FROM allocations WHERE tenant_id = ? AND allocated_at >= ? AND allocated_at < ?`,
    T, start, end,
  );
  const released = await first<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM allocations WHERE tenant_id = ? AND status = 'RELEASED' AND released_at >= ? AND released_at < ?`, T, start, end);
  const outside = await all<{ detail_json: string; outlet: string | null; category: string | null }>(
    ctx.db,
    `SELECT l.detail_json, o.name AS outlet, ${SEGMENT_SQL} AS category
       FROM audit_log l LEFT JOIN bookings b ON b.id = l.entity_id LEFT JOIN outlets o ON o.id = json_extract(l.detail_json, '$.outlet_id')
      WHERE l.tenant_id = ? AND l.action = 'ALLOTTED_OUTSIDE_SYSTEM' AND l.at >= ? AND l.at < ?`,
    T, start, end,
  );
  const kinds = new Map<string, number>();
  const outPlaces = new Map<string, number>();
  for (const o of outside) {
    const kind = String(safe<{ violation?: string }>(o.detail_json, {}).violation ?? "");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const k = `${o.outlet ?? "—"}\u0000${segment(o.category ?? "")}`;
    outPlaces.set(k, (outPlaces.get(k) ?? 0) + 1);
  }
  const allocations: DayEndData["allocations"] = {
    made_here: num(allocs?.here),
    from_dms: num(allocs?.dms),
    released: num(released?.n),
    outside: outside.length,
    outside_by_kind: [...kinds.entries()].map(([k, n]) => ({ label: OUTSIDE_LABELS[k] ?? "Allotted in the DMS", n })),
    outside_by_place: [...outPlaces.entries()].map(([k, n]) => ({ outlet: k.split("\u0000")[0], segment: k.split("\u0000")[1], n })).sort((a, b) => a.outlet.localeCompare(b.outlet) || a.segment.localeCompare(b.segment)),
  };

  const now = localParts(ctx.now, tz);
  return {
    dealership: ctx.tenant.name,
    oem: ctx.tenant.oem,
    date,
    prepared_at: now.date === date ? now.time : now.date > date ? "end of day" : now.time,
    url: siteUrl(ctx),
    people,
    files,
    last_files,
    requests,
    allocations,
  };
}

// ---------------------------------------------------------------- rendering

const NAVY = "#002858";
const TEAL = "#0098a8";
const INK = "#1b2733";
const MUTED = "#5b6672";
const LINE = "#dfe6ec";
const SOFT = "#f4f7f9";
const FONT = "Helvetica,Arial,sans-serif";
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number) => n.toLocaleString("en-IN");
const many = (n: number, one: string, more = `${one}s`) => `${fmt(n)} ${n === 1 ? one : more}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const longDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]}, ${day} ${MONTHS[m - 1]} ${y}`;
};
const shortDate = (d: string | null) => {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
};

function section(no: number, title: string, body: string): string {
  return `<tr><td style="padding:26px 32px 0;">
    <p style="margin:0 0 10px;font:700 12px/1.4 ${FONT};color:${NAVY};letter-spacing:1.2px;text-transform:uppercase;border-bottom:2px solid ${NAVY};padding-bottom:6px;">${no}. ${esc(title)}</p>
    ${body}
  </td></tr>`;
}

/** A table: the first column left, the rest right-aligned numbers unless told otherwise. */
function table(head: string[], rows: (string | number)[][], opts: { left?: number[]; total?: (string | number)[] } = {}): string {
  const left = new Set([0, ...(opts.left ?? [])]);
  const cell = (v: string | number, i: number, th = false, bold = false) =>
    `<${th ? "th" : "td"} style="padding:7px 8px;border-bottom:1px solid ${LINE};text-align:${left.has(i) ? "left" : "right"};font:${th ? "700 11px/1.3" : bold ? "700 13px/1.4" : "400 13px/1.4"} ${FONT};color:${th ? MUTED : INK};${th ? "text-transform:uppercase;letter-spacing:.6px;background:" + SOFT + ";" : ""}white-space:${th || left.has(i) ? "normal" : "nowrap"};">${typeof v === "number" ? fmt(v) : esc(v)}</${th ? "th" : "td"}>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${LINE};">
    <tr>${head.map((h, i) => cell(h, i, true)).join("")}</tr>
    ${rows.map((r) => `<tr>${r.map((v, i) => cell(v, i)).join("")}</tr>`).join("")}
    ${opts.total ? `<tr>${opts.total.map((v, i) => cell(v, i, false, true)).join("")}</tr>` : ""}
  </table>`;
}

const note = (s: string) => `<p style="margin:8px 0 0;font:400 12px/1.5 ${FONT};color:${MUTED};">${esc(s)}</p>`;
const none = (s: string) => `<p style="margin:0;padding:10px 12px;background:${SOFT};border:1px solid ${LINE};font:400 13px/1.5 ${FONT};color:${MUTED};">${esc(s)}</p>`;

function tiles(items: [string, number, string?][]): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 4) {
    const part = items.slice(i, i + 4);
    rows.push(`<tr>${part
      .map(([label, n, sub]) => `<td width="25%" valign="top" style="padding:4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-top:3px solid ${TEAL};">
          <tr><td style="padding:10px 12px;">
            <div style="font:700 22px/1.2 ${FONT};color:${NAVY};">${fmt(n)}</div>
            <div style="font:600 11px/1.35 ${FONT};color:${INK};margin-top:4px;">${esc(label)}</div>
            <div style="font:400 11px/1.35 ${FONT};color:${MUTED};margin-top:2px;">${sub ? esc(sub) : "&nbsp;"}</div>
          </td></tr>
        </table>
      </td>`)
      .join("")}${"<td width=\"25%\"></td>".repeat(4 - part.length)}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>`;
}

/** The report as an HTML page. `logo` is how the page refers to the product mark (a cid: in a message, a path in the app). */
export function dayEndHtml(d: DayEndData, opts: { logo?: string; greeting?: string } = {}): string {
  const r = d.requests;
  const a = d.allocations;
  const p = d.people;
  const sum = (list: { raised: number; approved: number; rejected: number; pending: number }[]) => list.reduce((t, x) => ({ raised: t.raised + x.raised, approved: t.approved + x.approved, rejected: t.rejected + x.rejected, pending: t.pending + x.pending }), { raised: 0, approved: 0, rejected: 0, pending: 0 });

  const peopleBody = p.list.length ? table(["Name", "Role", "Signed in at"], p.list.map((x) => [x.name, x.role, x.times.join(", ")]), { left: [1, 2] }) : none("Nobody signed in on this day.");

  const filesBody =
    (d.files.length
      ? table(["File", "Loaded at", "By", "As on", "Rows", "New", "Updated", "Errors"], d.files.map((f) => [f.label, f.at, f.by, shortDate(f.report_date), f.rows, f.created, f.updated, f.errors]), { left: [2, 3] }) +
        `<div style="height:8px;"></div>` +
        d.files.map((f) => `<p style="margin:4px 0 0;font:400 13px/1.5 ${FONT};color:${INK};"><span style="font-weight:700;">${esc(f.label)} (${esc(f.at)}):</span> ${esc(f.brief)}.</p>`).join("")
      : none("No DMS file was loaded on this day.")) +
    note(`Last loaded: ${d.last_files.map((f) => `${f.label} ${f.at ? shortDate(f.at.slice(0, 10)) + " " + f.at.slice(11) : "never"}`).join(" · ")}.`);

  const reqTotal = sum(r.by_type);
  const requestsBody =
    (r.by_type.length
      ? table(["Request", "Raised", "Approved", "Rejected", "Pending"], r.by_type.map((x) => [x.label, x.raised, x.approved, x.rejected, x.pending]), { total: ["Total", reqTotal.raised, reqTotal.approved, reqTotal.rejected, reqTotal.pending] }) +
        `<div style="height:12px;"></div>` +
        table(["Outlet", "Segment", "Raised", "Approved", "Rejected", "Pending"], r.by_place.map((x) => [x.outlet, x.segment, x.raised, x.approved, x.rejected, x.pending]), { left: [1] })
      : none("No request was raised or decided, and none is pending.")) +
    note(
      `Raised, approved and rejected count this day only; pending counts every request still open at the end of it${r.overdue ? `, of which ${fmt(r.overdue)} ha${r.overdue === 1 ? "s" : "ve"} waited longer than ${r.sla_hours} hours` : ""}.${r.withdrawn ? ` ${fmt(r.withdrawn)} withdrawn.` : ""}`,
    );

  const allocBody =
    table(
      ["Allocations", "Cars"],
      [
        ["Allocated in VINeeti (queue and approved requests)", a.made_here],
        ["Taken on from DMS allotments", a.from_dms],
        ["Released (taken back, cancelled or timed out)", a.released],
        ["Allotted in the DMS outside VINeeti", a.outside],
      ],
    ) +
    (a.outside
      ? `<div style="height:12px;"></div>` +
        table(["Outside VINeeti, by kind", "Cars"], a.outside_by_kind.map((x) => [x.label, x.n])) +
        `<div style="height:12px;"></div>` +
        table(["Outlet", "Segment", "Cars"], a.outside_by_place.map((x) => [x.outlet, x.segment, x.n]), { left: [1] })
      : "") +
    note("Allotments outside VINeeti are found when a stock report is loaded; a day with no stock report shows none.");

  const logo = opts.logo ? `<img src="${esc(opts.logo)}" width="132" alt="VINeeti" style="display:block;border:0;width:132px;height:auto;">` : `<span style="font:700 18px/1 ${FONT};color:#ffffff;">VINeeti</span>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Day-end report · ${esc(d.dealership)} · ${esc(shortDate(d.date))}</title></head>
<body style="margin:0;padding:0;background:${SOFT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(`${fmt(p.signed_in)} signed in · ${fmt(d.files.length)} DMS files · ${fmt(r.raised)} requests raised, ${fmt(r.pending)} pending · ${fmt(a.outside)} allotted outside VINeeti`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SOFT};">
  <tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:720px;max-width:100%;background:#ffffff;border:1px solid ${LINE};">
      <tr><td style="background:${NAVY};padding:20px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle">${opts.logo ? `<div style="background:#ffffff;display:inline-block;padding:6px 10px;border-radius:4px;">${logo}</div>` : logo}</td>
          <td valign="middle" align="right" style="font:700 12px/1.4 ${FONT};color:#cfe3ea;letter-spacing:1.4px;text-transform:uppercase;">Day-end report</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 32px 4px;">
        <h1 style="margin:0;font:700 22px/1.3 ${FONT};color:${NAVY};">${esc(d.dealership)}</h1>
        <p style="margin:4px 0 0;font:400 14px/1.5 ${FONT};color:${MUTED};">${esc(d.oem)} · ${esc(longDate(d.date))} · figures as at ${esc(d.prepared_at)}</p>
      </td></tr>
      ${
        opts.greeting
          ? `<tr><td style="padding:16px 32px 0;">
               <p style="margin:0 0 8px;font:400 14px/1.6 ${FONT};color:${INK};">${esc(opts.greeting)},</p>
               <p style="margin:0;font:400 14px/1.6 ${FONT};color:${INK};">Please find below the summary of activity in VINeeti at ${esc(d.dealership)} for ${esc(longDate(d.date))}.</p>
             </td></tr>`
          : ""
      }
      <tr><td style="padding:14px 28px 0;">
        ${tiles([
          ["People signed in", p.signed_in],
          ["DMS files loaded", d.files.length],
          ["Requests raised", r.raised],
          ["Requests pending", r.pending, r.overdue ? `${fmt(r.overdue)} past ${r.sla_hours} h` : undefined],
          ["Requests approved", r.approved],
          ["Requests rejected", r.rejected],
          ["Allocated in VINeeti", a.made_here],
          ["Allotted outside VINeeti", a.outside],
        ])}
      </td></tr>
      ${section(1, "People who signed in", peopleBody)}
      ${section(2, "DMS data loaded", filesBody)}
      ${section(3, "Allocation and deallocation requests", requestsBody)}
      ${section(4, "Allocations, and allotments outside VINeeti", allocBody)}
      ${
        opts.greeting
          ? `<tr><td style="padding:24px 32px 0;">
               <p style="margin:0;font:400 14px/1.6 ${FONT};color:${INK};">Regards,</p>
               <p style="margin:2px 0 0;font:600 14px/1.6 ${FONT};color:${NAVY};">VINeeti</p>
               <p style="margin:0;font:400 13px/1.6 ${FONT};color:${MUTED};">${esc(d.dealership)}</p>
             </td></tr>`
          : ""
      }
      <tr><td style="padding:24px 32px 26px;">
        <div style="height:1px;background:${LINE};margin-bottom:12px;"></div>
        <p style="margin:0;font:400 12px/1.6 ${FONT};color:${MUTED};">Business day ${esc(shortDate(d.date))}, midnight to midnight, dealership time. Prepared by VINeeti${d.url ? ` · <a href="${esc(d.url)}" style="color:${TEAL};">${esc(d.url.replace(/^https?:\/\//, ""))}</a>` : ""}. This is an automated report; please do not reply to it.</p>
        <p style="margin:6px 0 0;font:600 12px/1.6 ${FONT};color:${NAVY};">VINeeti · A product by JBR Consulting</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** The plain-text alternative: the headline figures. */
export function dayEndText(d: DayEndData, greeting?: string): string {
  const r = d.requests;
  const a = d.allocations;
  return [
    ...(greeting ? [`${greeting},`, "", `Please find below the summary of activity in VINeeti at ${d.dealership} for ${longDate(d.date)}.`, ""] : []),
    `Day-end report — ${d.dealership}`,
    `${longDate(d.date)}, figures as at ${d.prepared_at}`,
    "",
    `People signed in: ${d.people.signed_in}${d.people.list.length ? ` (${d.people.list.map((p) => p.name).join(", ")})` : ""}`,
    `DMS files loaded: ${d.files.length ? d.files.map((f) => `${f.label} at ${f.at}`).join(", ") : "none"}`,
    `Requests: ${r.raised} raised, ${r.approved} approved, ${r.rejected} rejected, ${r.pending} pending`,
    `Allocations: ${a.made_here} in VINeeti, ${a.released} released, ${a.outside} allotted in the DMS outside VINeeti`,
    "",
    "The full report is in the HTML version of this message.",
    d.url ? `VINeeti: ${d.url}` : "",
    ...(greeting ? ["", "Regards,", "VINeeti", d.dealership] : []),
  ].join("\n");
}

// ---------------------------------------------------------------- sending

export interface Recipient {
  name: string;
  role: string;
  email: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who receives the report: active people of the chosen roles who have an email address, and the further addresses. */
export async function dayEndRecipients(ctx: Ctx): Promise<{ to: Recipient[]; without_email: { name: string; role: string }[] }> {
  const cfg = ctx.settings.day_end_report;
  const people = cfg.roles.length
    ? await all<{ name: string; role: string; email: string | null }>(
        ctx.db,
        `SELECT name, role, email FROM users WHERE tenant_id = ? AND is_active = 1 AND role IN (SELECT value FROM json_each(?)) ORDER BY role, name`,
        ctx.tenantId, JSON.stringify(cfg.roles),
      )
    : [];
  const to: Recipient[] = [];
  const seen = new Set<string>();
  const without_email: { name: string; role: string }[] = [];
  for (const p of people) {
    const e = (p.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(e)) { without_email.push({ name: p.name, role: ROLE_LABELS[p.role as Role] ?? p.role }); continue; }
    if (seen.has(e)) continue;
    seen.add(e);
    to.push({ name: p.name, role: ROLE_LABELS[p.role as Role] ?? p.role, email: e });
  }
  for (const raw of cfg.emails) {
    const e = raw.trim().toLowerCase();
    if (!EMAIL.test(e) || seen.has(e)) continue;
    seen.add(e);
    to.push({ name: "", role: "Added address", email: e });
  }
  return { to: to.slice(0, 40), without_email };
}

const SEND_WINDOW_MINUTES = 180;

/** The day before a date, `YYYY-MM-DD`. */
export const dayBefore = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * The day whose report is due now, or null. The emailed report is the previous day's, complete: it is
 * sent on a sending day once the set time has passed, once, with a failed send tried up to three times.
 */
export async function dayEndReportDue(ctx: Ctx): Promise<string | null> {
  const cfg = ctx.settings.day_end_report;
  if (!cfg.enabled) return null;
  const { date, time } = localParts(ctx.now, ctx.tenant.timezone);
  if (time < cfg.time) return null;
  // Only in the three hours after the set time. A report turned on, or a deployment made, late in the
  // day does not send the morning email in the evening; it goes the next morning. The job runs every
  // 15 minutes, so three hours leaves room for a failed send to be tried again.
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  if (minutes(time) - minutes(cfg.time) >= SEND_WINDOW_MINUTES) return null;
  if (!cfg.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return null;
  const covers = dayBefore(date);
  const row = await first<{ status: string; attempts: number }>(ctx.db, `SELECT status, attempts FROM day_end_reports WHERE tenant_id = ? AND business_date = ?`, ctx.tenantId, covers);
  return !row || (row.status === "FAILED" && row.attempts < 3) ? covers : null;
}

export interface SendResult {
  date: string;
  sent: string[];
  failed: { email: string; error: string }[];
  status: "SENT" | "PARTLY_SENT" | "FAILED" | "NO_RECIPIENTS" | "MAIL_NOT_CONFIGURED";
}

/**
 * Builds a day's report and emails it, one message per recipient with their name on it.
 *
 *   SCHEDULED  to the configured recipients; recorded against the day, so it goes once.
 *   ON_DEMAND  to the configured recipients, at somebody's request; recorded in the audit trail.
 *   `only`     to the addresses given alone (a person sending it to themselves); recorded in the audit trail.
 */
export async function sendDayEndReport(ctx: Ctx, date: string, opts: { trigger?: "SCHEDULED" | "ON_DEMAND"; only?: Recipient[] } = {}): Promise<SendResult> {
  const trigger = opts.trigger ?? "SCHEDULED";
  const only = opts.only;
  const post = mailer(ctx.env, () => ctx.now);
  const list = only ?? (await dayEndRecipients(ctx)).to;
  const result: SendResult = { date, sent: [], failed: [], status: "SENT" };
  if (!post) result.status = "MAIL_NOT_CONFIGURED";
  else if (!list.length) result.status = "NO_RECIPIENTS";
  else {
    const data = await gatherDayEnd(ctx, date);
    const logo = await emailMark(ctx.env, "email-logo.png");
    const subject = dayEndSubject(data);
    for (const r of list) {
      const greeting = r.name ? `Dear ${r.name.split(" ")[0]}` : "Dear Sir / Madam";
      try {
        await post.send({
          to: r.email,
          subject,
          body: dayEndText(data, greeting),
          html: dayEndHtml(data, { logo: logo ? "cid:vineeti-logo" : undefined, greeting }),
          ...(logo ? { images: { "vineeti-logo": logo } } : {}),
        });
        result.sent.push(r.email);
      } catch (e) {
        result.failed.push({ email: r.email, error: e instanceof MailError ? e.code : String((e as Error)?.message ?? "").slice(0, 120) });
      }
    }
    result.status = !result.failed.length ? "SENT" : result.sent.length ? "PARTLY_SENT" : "FAILED";
  }
  if (only || trigger === "ON_DEMAND") {
    await run(
      ctx.db,
      `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, detail_json, at) VALUES (?,?,?,?,?,?,?,?)`,
      newId("aud"), ctx.tenantId, ctx.actor, "DAY_END_REPORT_SENT", "tenant", ctx.tenantId,
      JSON.stringify({ date, trigger: only ? "TO_SELF" : "ON_DEMAND", status: result.status, sent: result.sent, failed: result.failed }), iso(ctx.now),
    );
  } else {
    const now = iso(ctx.now);
    await run(
      ctx.db,
      `INSERT INTO day_end_reports (id, tenant_id, business_date, status, attempts, recipients_json, error, sent_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?7)
       ON CONFLICT (tenant_id, business_date) DO UPDATE SET status = excluded.status, attempts = day_end_reports.attempts + 1,
         recipients_json = excluded.recipients_json, error = excluded.error, sent_at = excluded.sent_at`,
      newId("der"), ctx.tenantId, date, result.status, JSON.stringify(result.sent), result.failed.length ? JSON.stringify(result.failed) : result.status === "SENT" ? null : result.status, now,
    );
  }
  return result;
}

/** The subject line: what it is, for whom, and the day. */
export const dayEndSubject = (d: DayEndData) => `VINeeti Day-End Report | ${d.dealership} | ${longDate(d.date)}`;

export interface SentReport {
  business_date: string;
  how: "Morning email" | "Sent on demand" | "Sent to self";
  by: string;
  status: string;
  attempts: number;
  recipients: number;
  sent_at: string;
}

/** The reports sent lately, by the morning email and on demand, for the screens. */
export async function dayEndHistory(ctx: Ctx): Promise<SentReport[]> {
  const scheduled = await all<{ business_date: string; status: string; attempts: number; recipients_json: string; sent_at: string }>(
    ctx.db,
    `SELECT business_date, status, attempts, recipients_json, sent_at FROM day_end_reports WHERE tenant_id = ? ORDER BY sent_at DESC LIMIT 15`,
    ctx.tenantId,
  );
  const asked = await all<{ detail_json: string; at: string; name: string | null }>(
    ctx.db,
    `SELECT l.detail_json, l.at, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.actor WHERE l.tenant_id = ? AND l.action = 'DAY_END_REPORT_SENT' ORDER BY l.at DESC LIMIT 15`,
    ctx.tenantId,
  );
  const out: SentReport[] = [
    ...scheduled.map((r) => ({ business_date: r.business_date, how: "Morning email" as const, by: "", status: r.status, attempts: r.attempts, recipients: safe<string[]>(r.recipients_json, []).length, sent_at: r.sent_at })),
    ...asked.map((r) => {
      const x = safe<{ date?: string; trigger?: string; status?: string; sent?: string[] }>(r.detail_json, {});
      return { business_date: x.date ?? "", how: x.trigger === "TO_SELF" ? ("Sent to self" as const) : ("Sent on demand" as const), by: r.name ?? "", status: x.status ?? "", attempts: 1, recipients: (x.sent ?? []).length, sent_at: r.at };
    }),
  ];
  return out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1)).slice(0, 15);
}
