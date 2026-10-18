// What the DMS has not been told yet.
//
// The DMS is the source of truth and this system is where the decision is made, which leaves a gap
// in between: a car this system has allocated is not allotted in the DMS until somebody keys it in,
// and a car this system has released is still allotted there until somebody takes it off. Until that
// happens the two disagree, and every report either of them produces is reporting half the story.
//
// So this is a work list, not a day's diary. It is built from the disagreement itself rather than
// from what changed today: every car where what this system holds and what the last stock report
// showed are not the same, with the action that would settle it. Two consequences, both wanted:
//
//   - a row that nobody acted on yesterday is still here today, rather than having scrolled off the
//     end of a date range and been quietly forgotten;
//   - a row disappears on its own as soon as a stock report shows the DMS agreeing, so there is no
//     "mark as done" for anybody to forget, lie about, or tick on the wrong line.
//
// Nothing here writes to the DMS. It produces the list a person works down.

import type { Ctx } from "../env";
import { all, first } from "../lib/db";
import { buildWorkbook } from "../lib/xlsx";
import { formatDate } from "./allocation";
import { releaseWords } from "./release-reasons";

/**
 * Release reasons the DMS already knows about, because this system learnt them *from* the DMS.
 *
 * A car released because the stock report stopped listing it, or because the DMS allotted it to
 * somebody else, needs nothing keyed in: the DMS is where that happened. Putting it on the work list
 * would have the back office "correcting" the DMS to match a decision the DMS itself made.
 */
const DMS_ALREADY_KNOWS = new Set([
  "CAR_LEFT_STOCK",
  "VEHICLE_REMOVED",
  "RELEASED_IN_DMS",
  "BILLED_WITH_ANOTHER_CAR",
  "ALLOTTED_IN_DMS_TO_ANOTHER_BOOKING",
  "ALLOTTED_ANOTHER_CAR_IN_DMS",
]);

export type WritebackAction = "ALLOT" | "REMOVE_ALLOTMENT";

export interface WritebackRow {
  action: WritebackAction;
  /** What to do, in the words of someone sitting in front of the DMS. */
  instruction: string;
  booking_id: string;
  /** The DMS order number: what the DMS calls this booking. */
  booking_no: string;
  /** The dealer-side booking number, for finding the order on a screen that asks for that one. */
  dms_ref: string | null;
  customer_name: string;
  outlet: string;
  /** The DMS's own Dealer Location Code, which is what its upload wants rather than the name. */
  outlet_code: string;
  vin: string;
  model: string;
  variant: string;
  colour: string;
  /** The DMS's Model Description for the car, exactly as its stock report writes it. */
  description: string;
  /** Where the car physically is, which is not always the booking's outlet. */
  vehicle_outlet: string;
  /** What the DMS currently shows this car against, when that is the disagreement. */
  dms_shows: string | null;
  decided_at: string;
  /** Why this system decided it: the release reason, or how the allocation came about. */
  reason: string;
  /** Who approved it, where a person did. */
  by: string;
  /** For a car moving between two bookings, the other half of the move. */
  paired_with: string | null;
  days_waiting: number;
}

/**
 * Where every allocation this system has ever made now stands.
 *
 * Without this the list invites an arithmetic nobody can finish: the allocations report counts what
 * was decided in a chosen set of dates, this list carries what is outstanding right now whatever day
 * it was decided, and the difference between the two numbers has no home. So the difference is given
 * one. Every allocation falls into exactly one line below and the lines add up to the total.
 */
export interface Reconcile {
  /** Every allocation on record, of any age and any status. */
  total: number;
  /** Still held here, and the last stock report showed the DMS holding it for the same booking. */
  confirmed: number;
  /** Still held here, the DMS does not show it: these are the allotments to make. */
  to_allot: number;
  /** Still held here, but the DMS has already invoiced the car to another order. Not on the list. */
  sold_elsewhere: number;
  /** Let go here, and the DMS still shows it: these are the allotments to remove. */
  to_remove: number;
  /** Let go here, and the DMS already agrees -- usually because the DMS is where it was let go. */
  released_settled: number;
  /** Delivered and closed. */
  fulfilled: number;
}

export interface Writeback {
  rows: WritebackRow[];
  totals: { allot: number; remove: number };
  reconcile: Reconcile;
  /**
   * Cars held here that the DMS already holds for a different order. They are deliberately not on
   * the list: keying one in would mean overwriting somebody else's allotment, which is a conflict
   * for a person to settle, not a line for the back office to work down.
   */
  conflicts: { booking_no: string; customer_name: string; vin: string; dms_booking_no: string }[];
  generated_at: string;
  basis: string;
}

interface Raw {
  allocation_id: string;
  booking_id: string;
  booking_no: string;
  dms_ref: string | null;
  customer_name: string;
  outlet: string;
  outlet_code: string;
  vehicle_outlet: string;
  vin: string;
  model: string;
  variant: string;
  colour: string;
  description: string | null;
  decided_at: string;
  release_reason: string | null;
  source: string;
  type: string;
  out_of_turn: number;
  dms_booking_no: string | null;
  dms_stock_type: string | null;
  released_to_booking_id: string | null;
  released_to_booking_no: string | null;
  approver: string | null;
  exception_id: string | null;
}

const scoped = (outletIds: string[] | null, column: string) => (outletIds ? ` AND ${column} IN (SELECT value FROM json_each(?2))` : "");
const daysSince = (at: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 86_400_000));

/**
 * The cars this system and the DMS disagree about.
 *
 * Allotments to make: a car held for a booking that the last stock report did not show against that
 * booking. Allotments to remove: a car this system let go of that the last stock report still shows
 * against the booking it was let go from.
 *
 * Allocations the DMS made in the first place are not listed. They are already true there, and the
 * separate question of whether they should have been made outside the system is what the violations
 * report is for.
 */
export async function dmsWriteback(ctx: Ctx, outletIds: string[] | null = null): Promise<Writeback> {
  const params: unknown[] = [ctx.tenantId];
  if (outletIds) params.push(JSON.stringify(outletIds));

  const pending = await all<Raw>(
    ctx.db,
    `SELECT a.id AS allocation_id, a.booking_id, b.booking_no, b.dms_ref, b.customer_name,
            o.name AS outlet, o.code AS outlet_code, vo.name AS vehicle_outlet,
            v.vin, v.model, v.variant, v.colour, v.description, v.dms_booking_no, v.dms_stock_type,
            a.allocated_at AS decided_at, NULL AS release_reason, a.source, a.type, a.out_of_turn,
            NULL AS released_to_booking_id, NULL AS released_to_booking_no,
            u.name AS approver, a.exception_id
       FROM allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN vehicles v ON v.id = a.vehicle_id
       JOIN outlets o ON o.id = b.outlet_id
       JOIN outlets vo ON vo.id = v.outlet_id
       LEFT JOIN exceptions e ON e.id = a.exception_id
       LEFT JOIN users u ON u.id = e.decided_by
      WHERE a.tenant_id = ?1 AND a.status = 'ACTIVE'
        -- The DMS does not show this car against this booking. Blank covers a car the DMS has as
        -- free stock; a different number covers one the DMS has moved to somebody else, which under
        -- this system's authority over allocation is the DMS being out of step, not a decision.
        --
        -- Where the allotment originally came from does not matter. An allocation this system holds
        -- is the allocation, so one the DMS made and has since moved still has to be put back.
        AND (v.dms_booking_no IS NULL OR v.dms_booking_no <> b.booking_no)${scoped(outletIds, "b.outlet_id")}
      ORDER BY a.allocated_at`,
    ...params,
  );

  const toRemove = await all<Raw>(
    ctx.db,
    `SELECT a.id AS allocation_id, a.booking_id, b.booking_no, b.dms_ref, b.customer_name,
            o.name AS outlet, o.code AS outlet_code, vo.name AS vehicle_outlet,
            v.vin, v.model, v.variant, v.colour, v.description, v.dms_booking_no, v.dms_stock_type,
            a.released_at AS decided_at, a.release_reason, a.source, a.type, a.out_of_turn,
            a.released_to_booking_id, tb.booking_no AS released_to_booking_no,
            u.name AS approver, a.exception_id
       FROM allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN vehicles v ON v.id = a.vehicle_id
       JOIN outlets o ON o.id = b.outlet_id
       JOIN outlets vo ON vo.id = v.outlet_id
       LEFT JOIN bookings tb ON tb.id = a.released_to_booking_id
       LEFT JOIN exceptions e ON e.id = a.release_request_id
       LEFT JOIN users u ON u.id = e.decided_by
      WHERE a.tenant_id = ?1 AND a.status = 'RELEASED' AND a.released_at IS NOT NULL
        -- Still allotted in the DMS to the booking this system took it off.
        AND v.dms_booking_no = b.booking_no${scoped(outletIds, "b.outlet_id")}
      ORDER BY a.released_at`,
    ...params,
  );

  const rows: WritebackRow[] = [];
  for (const r of toRemove) {
    if (r.release_reason && DMS_ALREADY_KNOWS.has(r.release_reason)) continue;
    rows.push({
      action: "REMOVE_ALLOTMENT",
      instruction: `Remove the allotment of ${r.vin} from booking ${r.booking_no}`,
      booking_id: r.booking_id,
      booking_no: r.booking_no,
      dms_ref: r.dms_ref,
      customer_name: r.customer_name,
      outlet: r.outlet,
      outlet_code: r.outlet_code,
      vin: r.vin,
      model: r.model,
      variant: r.variant,
      colour: r.colour,
      description: r.description ?? `${r.model} ${r.variant}`,
      vehicle_outlet: r.vehicle_outlet,
      dms_shows: `Allotted to ${r.booking_no}`,
      decided_at: r.decided_at,
      reason: releaseWords(r.release_reason),
      by: r.approver ?? "",
      paired_with: r.released_to_booking_no ? `Then allot it to ${r.released_to_booking_no}` : null,
      days_waiting: daysSince(r.decided_at, ctx.now),
    });
  }
  // Which allotments this sheet is already asking to have taken off. A car the DMS shows against a
  // booking that is being removed two lines above is not a conflict -- it is the first half of the
  // move, and the allotment will be free by the time the operator reaches the second half.
  const beingFreed = new Map<string, Set<string>>();
  for (const r of rows) (beingFreed.get(r.vin) ?? beingFreed.set(r.vin, new Set()).get(r.vin)!).add(r.booking_no);

  // A car the DMS shows allotted to another order is not a conflict: allocation is this system's
  // decision and the DMS is simply out of step, so putting it back is the whole point of this sheet.
  //
  // One case cannot be put back. A car the DMS has already invoiced to another order has been sold:
  // there is a customer with paperwork and most likely the car. Loading a line that reverses that
  // would undo a completed sale off a spreadsheet, so those are named for the approvers instead.
  const conflicts = pending
    .filter((r) => r.dms_stock_type === "IBND" && r.dms_booking_no && r.dms_booking_no !== r.booking_no)
    .map((r) => ({ booking_no: r.booking_no, customer_name: r.customer_name, vin: r.vin, dms_booking_no: r.dms_booking_no as string }));
  const conflicted = new Set(conflicts.map((c) => `${c.vin}:${c.booking_no}`));

  for (const r of pending) {
    if (conflicted.has(`${r.vin}:${r.booking_no}`)) continue;
    rows.push({
      action: "ALLOT",
      instruction: `Allot ${r.vin} to booking ${r.booking_no}`,
      booking_id: r.booking_id,
      booking_no: r.booking_no,
      dms_ref: r.dms_ref,
      customer_name: r.customer_name,
      outlet: r.outlet,
      outlet_code: r.outlet_code,
      vin: r.vin,
      model: r.model,
      variant: r.variant,
      colour: r.colour,
      description: r.description ?? `${r.model} ${r.variant}`,
      vehicle_outlet: r.vehicle_outlet,
      // What the DMS has against this car right now, which is what the upload has to overwrite.
      // Where it is coming off another booking on this same sheet, say so: the operator needs to
      // know the allotment is not free until the line above has gone in.
      dms_shows: r.dms_booking_no
        ? `Allotted to ${r.dms_booking_no}${beingFreed.get(r.vin)?.has(r.dms_booking_no) ? ", removed above" : ""}`
        : r.dms_stock_type === "IBND"
          ? "Invoiced"
          : "Free stock",
      decided_at: r.decided_at,
      reason: r.source === "EXCEPTION" ? "By approved request" : r.out_of_turn ? "Allocated by the queue (out of turn)" : "Allocated by the queue",
      by: r.approver ?? "",
      paired_with: null,
      days_waiting: daysSince(r.decided_at, ctx.now),
    });
  }

  // Where every allocation stands, so the difference between this list and the allocations report
  // accounts for itself instead of being a question. Counted in the database rather than over the
  // rows above, because the rows above are only the two lines that need doing.
  const counts = await first<{ total: number; confirmed: number; active_elsewhere: number; active_unseen: number; released_shown: number; released_settled: number; fulfilled: number }>(
    ctx.db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'ACTIVE' AND v.dms_booking_no = b.booking_no THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN a.status = 'ACTIVE' AND v.dms_booking_no IS NOT NULL AND v.dms_booking_no <> b.booking_no AND v.dms_stock_type = 'IBND' THEN 1 ELSE 0 END) AS active_elsewhere,
            SUM(CASE WHEN a.status = 'ACTIVE' AND (v.dms_booking_no IS NULL OR (v.dms_booking_no <> b.booking_no AND COALESCE(v.dms_stock_type, '') <> 'IBND')) THEN 1 ELSE 0 END) AS active_unseen,
            SUM(CASE WHEN a.status = 'RELEASED' AND v.dms_booking_no = b.booking_no THEN 1 ELSE 0 END) AS released_shown,
            SUM(CASE WHEN a.status = 'RELEASED' AND (v.dms_booking_no IS NULL OR v.dms_booking_no <> b.booking_no) THEN 1 ELSE 0 END) AS released_settled,
            SUM(CASE WHEN a.status = 'FULFILLED' THEN 1 ELSE 0 END) AS fulfilled
       FROM allocations a
       JOIN bookings b ON b.id = a.booking_id
       JOIN vehicles v ON v.id = a.vehicle_id
      WHERE a.tenant_id = ?1${scoped(outletIds, "b.outlet_id")}`,
    ...params,
  );
  // A released allocation the DMS still shows, whose release the DMS already knows about, is settled
  // as far as anybody keying things in is concerned; it is on neither list.
  const removeRows = rows.filter((r) => r.action === "REMOVE_ALLOTMENT").length;
  const reconcile: Reconcile = {
    total: Number(counts?.total ?? 0),
    confirmed: Number(counts?.confirmed ?? 0),
    to_allot: rows.filter((r) => r.action === "ALLOT").length,
    sold_elsewhere: Number(counts?.active_elsewhere ?? 0),
    to_remove: removeRows,
    released_settled: Number(counts?.released_settled ?? 0) + Math.max(0, Number(counts?.released_shown ?? 0) - removeRows),
    fulfilled: Number(counts?.fulfilled ?? 0),
  };

  // Removals first: a car has to come off one booking before it can go on another, and a pair that
  // is keyed the other way round is rejected by the DMS for a reason nobody will enjoy diagnosing.
  rows.sort((x, y) => (x.action === y.action ? x.decided_at.localeCompare(y.decided_at) : x.action === "REMOVE_ALLOTMENT" ? -1 : 1));

  return {
    rows,
    totals: { allot: reconcile.to_allot, remove: reconcile.to_remove },
    reconcile,
    conflicts,
    generated_at: ctx.now.toISOString(),
    basis:
      "Every car this system and the DMS do not agree about, compared against the latest stock report loaded. " +
      "Allotments the DMS made itself are not listed; nor are releases the DMS already knows about, such as a car that left stock or was allotted elsewhere there. " +
      "A car the DMS has already invoiced to another order is left off and counted separately: that sale has happened and is not reversed from a spreadsheet. " +
      "A line disappears from this list when a stock report shows the DMS agreeing, so nothing has to be ticked off by hand.",
  };
}

/**
 * The upload file.
 *
 * Two tabs, one kind of row each, in the DMS's own column names -- "Order ID", "Chassis Number",
 * "Dealer Location Code" are what its stock report calls these things, so a row maps onto a DMS
 * screen without anybody translating. A single tab with an action column reads well to a person and
 * is useless to an importer, which is what this file is for.
 *
 * A third tab carries the reason, the approver and the request behind every line, because an upload
 * that changes who gets a car should not arrive at the DMS with no account of why.
 */
const ALLOT_HEADINGS = ["Dealer Location Code", "Order ID", "Chassis Number", "VIN", "Allotment Date", "Customer Name", "Model Description"];
const REMOVE_HEADINGS = ["Dealer Location Code", "Order ID", "Chassis Number", "VIN", "Release Date", "Customer Name", "Model Description"];
const AUDIT_HEADINGS = [
  "Action", "Order ID", "Booking Number", "Customer Name", "Chassis Number", "Model", "Variant", "Colour",
  "Outlet", "Car is at", "DMS currently shows", "Decided on", "Why", "Approved by", "Then", "Days waiting",
];

const day = (at: string) => at.slice(0, 10);

/** The same decisions as a workbook the DMS can take, with the account of them beside it. */
export function writebackXlsx(w: Writeback, dealer: string): Uint8Array {
  const allot = w.rows.filter((r) => r.action === "ALLOT");
  const remove = w.rows.filter((r) => r.action === "REMOVE_ALLOTMENT");
  const widths = [22, 20, 22, 22, 16, 28, 44];
  return buildWorkbook([
    {
      name: "Allot",
      rows: [ALLOT_HEADINGS, ...allot.map((r) => [r.outlet_code, r.booking_no, r.vin, r.vin, day(r.decided_at), r.customer_name, r.description])],
      widths,
    },
    {
      name: "Remove allotment",
      rows: [REMOVE_HEADINGS, ...remove.map((r) => [r.outlet_code, r.booking_no, r.vin, r.vin, day(r.decided_at), r.customer_name, r.description])],
      widths,
    },
    {
      name: "Why",
      rows: [
        [`${dealer} — allocation decisions to load into the DMS`],
        [`As on ${formatDate(day(w.generated_at))} · ${remove.length} allotment(s) to remove, ${allot.length} to make`],
        [w.basis],
        [],
        ["Every allocation on record, and where it stands"],
        ["  Already matching in the DMS", w.reconcile.confirmed],
        ["  To allot (on the Allot tab)", w.reconcile.to_allot],
        ["  To remove (on the Remove allotment tab)", w.reconcile.to_remove],
        ["  Let go here, and the DMS already agrees", w.reconcile.released_settled],
        ["  Already invoiced in the DMS to another order", w.reconcile.sold_elsewhere],
        ["  Delivered and closed", w.reconcile.fulfilled],
        ["  Total", w.reconcile.total],
        [],
        AUDIT_HEADINGS,
        ...w.rows.map((r) => [
          r.action === "ALLOT" ? "Allot" : "Remove allotment",
          r.booking_no,
          r.dms_ref ?? "",
          r.customer_name,
          r.vin,
          r.model,
          r.variant,
          r.colour,
          r.outlet,
          r.vehicle_outlet,
          r.dms_shows ?? "",
          formatDate(day(r.decided_at)),
          r.reason,
          r.by,
          r.paired_with ?? "",
          r.days_waiting,
        ]),
        ...(w.conflicts.length
          ? [
              [],
              [`Not in the upload: ${w.conflicts.length} car(s) the DMS has already invoiced or delivered to another order. Those sales stand; they are raised to the VP instead.`],
              ...w.conflicts.map((c) => [`  ${c.vin} — allocated here to ${c.booking_no} (${c.customer_name}), ${c.dms_booking_no} in the DMS`]),
            ]
          : []),
      ],
      widths: [18, 20, 18, 26, 22, 16, 28, 20, 18, 18, 26, 14, 30, 20, 28, 12],
    },
  ]);
}
