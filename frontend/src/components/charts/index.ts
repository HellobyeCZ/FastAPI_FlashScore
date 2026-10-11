/**
 * Chart contract. Pages import charts ONLY from "@/components/charts".
 * Every chart: sizes to its container when `width` is omitted, takes an
 * `ariaLabel`-style accessible summary where available, uses token colors
 * (`rgb(var(--…))`) and the categorical model palette from lib/labels.
 */
export { CalibrationPlot } from "./CalibrationPlot";
export { CumulativeLineChart } from "./CumulativeLine";
export type { Series as LineSeries } from "./CumulativeLine";
export { HeatmapChart } from "./HeatmapChart";
export type { HeatmapCell } from "./HeatmapChart";
export { ScatterChart } from "./ScatterChart";
export type { ScatterPoint } from "./ScatterChart";
export { ViolinChart } from "./ViolinChart";
export type { ViolinSeries } from "./ViolinChart";
export { HBarChart } from "./HBarChart";
export type { HBar, HBarChartProps } from "./HBarChart";
export { BinnedBarChart } from "./BinnedBarChart";
export type { Bin, BinnedBarChartProps } from "./BinnedBarChart";
export { Sparkline } from "./Sparkline";
