// Where the system's picture of stock and bookings comes from, and how old it is. Every screen shows
// this ("Stock as on 5 Oct, loaded today 09:10 by ..."), and steps that depend on fresh DMS data check it.

import type { Ctx } from "../env";
import { all } from "../lib/db";
import { localParts } from "../lib/util";

export interface FileStatus {
  upload_id: string;
  /** The date the file describes: the stock report's "as on" date, or the day the booking sheet was loaded. */
  report_date: string;
  loaded_at: string;
  loaded_by: string | null;
  filename: string | null;
  /** Whole days from the date the file describes to today. */
  age_days: number;
}

export interface DataStatus {
  stock: FileStatus | null;
  bookings: FileStatus | null;
  /** The files are expected at least this often. */
  expected_every_days: number;
  /** True when a DMS file has been loaded before and the latest stock report or booking sheet is older than agreed. */
  stale: boolean;
  /** Which of the two is out of date. */
  stale_files: ("STOCK" | "BOOKINGS")[];
}

export async function dataStatus(ctx: Ctx): Promise<DataStatus> {
  const cached = ctx.cache.get("data_status") as DataStatus | undefined;
  if (cached) return cached;
  const today = localParts(ctx.now, ctx.tenant.timezone).date;
  const rows = await all<{ id: string; kind: "STOCK" | "BOOKINGS"; report_date: string | null; at: string; filename: string | null; name: string | null }>(
    ctx.db,
    `SELECT u.id, u.kind, u.report_date, u.at, u.filename, us.name FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by
     WHERE u.tenant_id = ?1 AND u.status = 'DONE' AND u.id IN (
       SELECT id FROM uploads x WHERE x.tenant_id = ?1 AND x.status = 'DONE' AND x.kind = u.kind ORDER BY COALESCE(x.report_date, substr(x.at, 1, 10)) DESC, x.at DESC LIMIT 1)`,
    ctx.tenantId,
  );
  const days = (from: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
  const one = (kind: "STOCK" | "BOOKINGS"): FileStatus | null => {
    const r = rows.find((x) => x.kind === kind);
    if (!r) return null;
    const date = r.report_date ?? localParts(new Date(r.at), ctx.tenant.timezone).date;
    return { upload_id: r.id, report_date: date, loaded_at: r.at, loaded_by: r.name, filename: r.filename, age_days: days(date) };
  };
  const stock = one("STOCK"), bookings = one("BOOKINGS");
  const limit = ctx.settings.data_stale_days;
  const staleFiles: DataStatus["stale_files"] = [];
  // Staleness only means something for a dealership that works from DMS files: before the first file, nothing is "late".
  if (stock || bookings) {
    if (!stock || stock.age_days > limit) staleFiles.push("STOCK");
    if (!bookings || bookings.age_days > limit) staleFiles.push("BOOKINGS");
  }
  const status: DataStatus = { stock, bookings, expected_every_days: limit, stale: staleFiles.length > 0, stale_files: staleFiles };
  ctx.cache.set("data_status", status);
  return status;
}
