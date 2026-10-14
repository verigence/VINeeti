// The pieces every board is built from, so the three boards look like one product rather than three.
//
// A board is one screen: a row of figures, a row of pictures, and the one list that has to be worked
// through, which scrolls inside its own panel instead of pushing the rest off the screen. Below a
// laptop width the grid flows and the whole thing scrolls as an ordinary page — a phone has no screen
// to fit a board on, and pretending otherwise would shrink every figure to nothing.

import type { EChartsCoreOption } from "echarts/core";
import { Chart } from "./Chart";
import { fmtDate, fmtNumber, plural } from "../format";
import { Link } from "../router";
import type { DataStatus } from "../types";

export const MUTED = "#5b6672";

/** Axis styling shared by every board chart: light rules, quiet labels, no ticks. */
export const axis = {
  axisLine: { lineStyle: { color: "#d9e2e8" } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 11 },
  splitLine: { lineStyle: { color: "#eef3f6" } },
};

/**
 * An age band written short enough to sit under a bar: "0-30 days" becomes "0-30", "Over 90 days"
 * becomes "90+". Four or five bands written out in full do not fit across a panel a third of a screen
 * wide, and a chart that hides every other label is worse than one that abbreviates every label. The
 * axis is titled "days" and the tooltip carries the band in full, so nothing is lost.
 */
export const shortBand = (label: string) => label.replace(/\s*days?$/i, "").replace(/^Over\s+(\d+)$/i, "$1+");

/** A category axis down the left of a horizontal bar chart: names truncated rather than wrapped. */
export const nameAxis = (names: string[], width = 150) => ({
  type: "category" as const,
  data: [...names].reverse(),
  ...axis,
  splitLine: { show: false },
  axisLabel: { ...axis.axisLabel, width, overflow: "truncate" as const },
});

/**
 * One figure on a board. `n` is a count; `value` is for anything already written out — money, days —
 * where the figure is a phrase rather than a number. The tone is only applied when there is something
 * to worry about: a red zero is a false alarm.
 */
export function Kpi({ n, value, label, tone, to }: { n?: number; value?: string; label: string; tone?: "warn" | "danger"; to?: string }) {
  const shown = value ?? fmtNumber(n);
  const worrying = tone && (value !== undefined ? value !== "—" : (n ?? 0) > 0);
  const cls = `board-kpi${worrying ? ` board-kpi-${tone}` : ""}`;
  const inner = (
    <>
      <span className="board-kpi-n">{shown}</span>
      <span className="board-kpi-label">{label}</span>
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/**
 * A panel on a board: the heading, the thing itself, and — folded away at the foot — the sentence that
 * says how the numbers were counted. The explanation is what makes a figure checkable, but it is not
 * what the person came to read, so it does not sit between the heading and the picture.
 */
export function Panel({ title, basis, children, grow }: { title: React.ReactNode; basis?: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <section className={`board-panel${grow ? " board-panel-grow" : ""}`}>
      <h2>{title}</h2>
      <div className="board-panel-body">{children}</div>
      {basis && (
        <details className="chart-basis">
          <summary>How this is counted</summary>
          <p>{basis}</p>
        </details>
      )}
    </section>
  );
}

/**
 * One line at the top of a board when the DMS files are behind. Every figure below it was worked out
 * from those files, so somebody deciding on this screen has to know the files are old — but on a screen
 * built to fit without scrolling, the full warning would cost a chart. When the files are current this
 * draws nothing at all.
 */
export function BoardStale({ source }: { source?: DataStatus }) {
  if (!source?.stale) return null;
  const oldest = [source.stock, source.bookings].filter(Boolean).sort((a, b) => b!.age_days - a!.age_days)[0];
  return (
    <p className="board-stale" role="alert">
      The DMS files are out of date{oldest ? ` — the stock report is as on ${fmtDate(source.stock?.report_date ?? oldest.report_date)}, ${plural(oldest.age_days, "day")} old` : ""}. Every figure here is from those files.{" "}
      <Link to="/eod">Load today's files</Link>
    </p>
  );
}

/** A chart in a panel. Nothing to draw means no panel: an empty box takes a chart's room and says less. */
export function ChartPanel({ title, basis, option, empty, height = 168 }: { title: string; basis?: string; option: EChartsCoreOption; empty?: boolean; height?: number }) {
  if (empty) return null;
  return (
    <Panel title={title} basis={basis}>
      <Chart option={option} height={height} />
    </Panel>
  );
}
