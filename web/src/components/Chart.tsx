// Charts, drawn with Apache ECharts (Apache-2.0). Only the parts used are bundled. Every chart is drawn
// from numbers the API already gives; nothing is computed in the browser.
import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

/** The product's colours, from the VINeeti mark: navy, teal, cyan, sky; then the status colours. */
export const PALETTE = ["#002858", "#0098a8", "#00a8c8", "#0090d0", "#7fbfd6", "#b85c38", "#9a2a20", "#5b6672"];
export const AGE_COLOURS = ["#0098a8", "#0090d0", "#c98a2e", "#9a2a20"];

const base: EChartsCoreOption = {
  color: PALETTE,
  textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: "#1b2733" },
  tooltip: { trigger: "axis", backgroundColor: "#002858", borderWidth: 0, textStyle: { color: "#fff", fontSize: 12 }, axisPointer: { type: "shadow" } },
  legend: { bottom: 0, icon: "roundRect", itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 12, color: "#5b6672" } },
  grid: { left: 8, right: 16, top: 12, bottom: 44, containLabel: true },
  animationDuration: 400,
};

export function Chart({ option, height = 260, className }: { option: EChartsCoreOption; height?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption({ ...base, ...option }, true);
  }, [option]);
  return <div ref={ref} className={`chart${className ? ` ${className}` : ""}`} style={{ height }} role="img" />;
}

/** Axis labels for a list of day strings: "6 Oct", shown sparsely when there are many. */
export const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
