// "Source and last update": which stock report and booking sheet the screen is showing, who loaded
// them and when, and a clear warning when either is older than the dealership has agreed.

import { api } from "../api";
import { fmtDate, fmtWhen, plural } from "../format";
import { useLoad } from "../hooks";
import { canLoadFiles } from "../nav";
import { Link } from "../router";
import { useSession } from "../session";
import type { DataStatus, FileStatus } from "../types";
import { Icon } from "./icons";

const by = (f: FileStatus) => (f.loaded_by ? ` by ${f.loaded_by}` : "");

/** What is wrong with one of the two files, in a sentence. */
function staleSentence(kind: "STOCK" | "BOOKINGS", s: DataStatus): string {
  const name = kind === "STOCK" ? "stock report" : "booking sheet";
  const f = kind === "STOCK" ? s.stock : s.bookings;
  if (!f) return `No ${name} has been loaded.`;
  const dated = kind === "STOCK" ? `as on ${fmtDate(f.report_date)}` : `loaded ${fmtDate(f.report_date)}`;
  return `The ${name} is out of date: ${dated}, ${plural(f.age_days, "day")} old. It is expected every ${plural(s.expected_every_days, "day")}.`;
}

export function DataSource({ status }: { status?: DataStatus }) {
  const { can } = useSession();
  const load = useLoad(() => (status ? Promise.resolve(status) : api.dataStatus()), status ? "data-status:given" : "data-status");
  const s = status ?? load.data;
  if (!s) return load.error ? <p className="source-line source-error">The date of the DMS files could not be read. {load.error}</p> : null;
  const mayLoad = canLoadFiles(can);
  const eodLink = mayLoad ? (
    <Link to="/eod" className="source-link">
      Load the files on End of day
    </Link>
  ) : null;

  if (!s.stock && !s.bookings) {
    return (
      <div className="source-line" role="note">
        <Icon name="info" size={16} />
        <span>
          No stock report or booking sheet has been loaded yet. {mayLoad ? eodLink : "The numbers appear once the DMS files are loaded."}
        </span>
      </div>
    );
  }
  return (
    <>
      {s.stale && (
        <div className="notice notice-warn source-stale" role="alert">
          <Icon name="warning" size={16} />
          <div>
            <strong className="notice-title">The DMS data is out of date. </strong>
            {s.stale_files.map((k) => staleSentence(k, s)).join(" ")} No car is re-allocated automatically until it is loaded. {eodLink}
          </div>
        </div>
      )}
      <div className="source-line" role="note">
        <span className="source-part">
          {s.stock ? (
            <>
              <strong>Stock as on {fmtDate(s.stock.report_date)}</strong> · loaded {fmtWhen(s.stock.loaded_at)}
              {by(s.stock)}
            </>
          ) : (
            "No stock report loaded"
          )}
        </span>
        <span className="source-sep" aria-hidden="true">
          |
        </span>
        <span className="source-part">
          {s.bookings ? (
            <>
              <strong>Booking sheet</strong> loaded {fmtWhen(s.bookings.loaded_at)}
              {by(s.bookings)}
            </>
          ) : (
            "No booking sheet loaded"
          )}
        </span>
      </div>
    </>
  );
}
