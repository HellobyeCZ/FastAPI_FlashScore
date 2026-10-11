"use client";

import { useMemo } from "react";
import { Group } from "@visx/group";
import { scaleBand } from "@visx/scale";
import { BoxPlot, ViolinPlot } from "@visx/stats";
import { seriesColor } from "@/lib/labels";
import { ChartFrame, ChartSvg, TICK_FONT, isFiniteNumber, jitter, tok } from "./frame";
import {
  STAGGER,
  TerminalAxisBottom,
  TerminalAxisLeft,
  categoryLayout,
  valueAxis,
  type AxisTick
} from "./TerminalAxis";
import { useChartText } from "./text";

export type ViolinSeries = {
  label: string;
  /** CSS color; empty falls back to the categorical palette by index. */
  color: string;
  values: number[];
};

interface ViolinChartProps {
  series: ViolinSeries[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  /** Dashed horizontal reference (e.g. 0 for CLV). */
  referenceY?: number;
  ariaLabel?: string;
  /** Formats y ticks and the summaries (default: locale number). */
  formatY?: (v: number) => string;
  /**
   * Groups with fewer values are drawn as individual points with a median
   * tick instead of a density estimate (default 8): a KDE of a handful of
   * values suggests a distribution that is not there.
   */
  minNForDensity?: number;
  emptyLabel?: string;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Silverman's rule of thumb: 1.06 * σ * n^(-1/5).
// Falls back to (max-min)/20 when σ is degenerate.
function silvermanBandwidth(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0.01;
  const sigma = stdev(values);
  if (sigma > 0) return 1.06 * sigma * Math.pow(n, -1 / 5);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (max - min) / 20 || 0.01;
}

function computeKde(values: number[]): { value: number; density: number }[] {
  if (values.length === 0) return [];
  const bandwidth = silvermanBandwidth(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Extend domain slightly past the data so the violin tails close.
  const pad = bandwidth * 2;
  const lo = min - pad;
  const hi = max + pad;
  const step = (hi - lo) / 64 || 0.001;
  const out: { value: number; density: number }[] = [];
  for (let x = lo; x <= hi; x += step) {
    let d = 0;
    for (const v of values) {
      const u = (x - v) / bandwidth;
      d += Math.exp(-0.5 * u * u);
    }
    out.push({ value: x, density: d / (values.length * bandwidth * Math.sqrt(2 * Math.PI)) });
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    firstQuartile: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    thirdQuartile: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? 0
  };
}

/**
 * Distribution per group: kernel density outline with a box plot inside,
 * n under every group label. Small groups fall back to a strip of points.
 */
export function ViolinChart(props: ViolinChartProps) {
  const { noData } = useChartText();
  const height = props.height ?? 260;
  const series = useMemo(
    () =>
      props.series
        .map((s, i) => ({ ...s, color: s.color || seriesColor(i), values: s.values.filter(isFiniteNumber) }))
        .filter((s) => s.values.length > 0),
    [props.series]
  );
  return (
    <ChartFrame width={props.width} height={height} empty={series.length === 0} emptyLabel={props.emptyLabel ?? noData}>
      {(w) => <ViolinPlotArea {...props} series={series} width={w} height={height} />}
    </ChartFrame>
  );
}

function ViolinPlotArea({
  series,
  width,
  height,
  xLabel,
  yLabel,
  referenceY,
  ariaLabel,
  formatY,
  minNForDensity = 8
}: ViolinChartProps & { width: number; height: number }) {
  const { t, fmt } = useChartText();
  const stats = useMemo(() => series.map((s) => summary(s.values)), [series]);
  const kdes = useMemo(
    () => series.map((s) => (s.values.length >= minNForDensity ? computeKde(s.values) : [])),
    [series, minNForDensity]
  );

  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all, referenceY ?? Infinity);
  let hi = Math.max(...all, referenceY ?? -Infinity);
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
  }

  // Bottom rows: group label (one or two staggered rows), n, optional axis title.
  const top = 10;
  const right = 12;
  const yTitle = yLabel ? 20 : 0;
  const labels = series.map((s) => s.label);
  const bandFor = (w: number) =>
    scaleBand<string>({ domain: series.map((_, i) => String(i)), range: [0, Math.max(40, w)], padding: 0.25 });
  let innerH = Math.max(40, height - top - 38 - (xLabel ? 20 : 0));
  let axis = valueAxis([lo, hi], innerH, fmt.num, formatY);
  let left = Math.ceil(axis.labelWidth + 12 + yTitle);
  if (categoryLayout(labels, bandFor(width - left - right).step()).rows === 2) {
    innerH = Math.max(40, innerH - STAGGER);
    axis = valueAxis([lo, hi], innerH, fmt.num, formatY);
    left = Math.max(left, Math.ceil(axis.labelWidth + 12 + yTitle));
  }
  const y = axis.scale;
  const fmtValue = formatY ?? ((v: number) => fmt.num(v, Math.max(2, axis.digits)));
  const innerW = Math.max(40, width - left - right);

  // Density tails run two bandwidths past the data; trim them to the plot.
  const [dLo, dHi] = y.domain();
  const x = bandFor(innerW);
  const band = x.bandwidth();
  const layout = categoryLayout(labels, x.step());
  const extraRow = (layout.rows - 1) * STAGGER;
  const xTicks: AxisTick[] = series.map((s, i) => ({
    value: String(i),
    pos: (x(String(i)) ?? 0) + band / 2,
    label: s.label
  }));

  const groupText = (i: number) =>
    t("violin.desc", { label: series[i].label, n: fmt.int(series[i].values.length), median: fmtValue(stats[i].median) });
  const desc = series.map((_, i) => groupText(i)).join("; ");

  return (
    <ChartSvg width={width} height={height} label={ariaLabel ?? t("violin.aria")} desc={desc}>
      <g transform={`translate(${left} ${top})`}>
        <TerminalAxisLeft ticks={axis.ticks} height={innerH} gridWidth={innerW} title={yLabel} titleX={-left + 2} />
        <TerminalAxisBottom
          ticks={xTicks}
          width={innerW}
          top={innerH}
          maxLabelWidth={layout.maxLabelWidth}
          labelDy={layout.labelDy}
          title={xLabel}
          titleY={innerH + 40 + extraRow}
        />
        {xTicks.map((tk, i) => (
          <text
            key={`n-${i}`}
            x={tk.pos}
            y={innerH + 24 + extraRow}
            textAnchor="middle"
            dominantBaseline="hanging"
            fontSize={TICK_FONT}
            fill={tok("text-faint")}
          >
            {`n = ${fmt.int(series[i].values.length)}`}
          </text>
        ))}
        {referenceY !== undefined && (
          <line x1={0} x2={innerW} y1={y(referenceY)} y2={y(referenceY)} stroke={tok("text-faint")} strokeDasharray="3 3" />
        )}
        {series.map((s, i) => {
          const cx = (x(String(i)) ?? 0) + band / 2;
          const st = stats[i];
          const dense = kdes[i].length > 0;
          return (
            <Group key={i} left={cx}>
              <title>{groupText(i)}</title>
              {dense ? (
                <>
                  <ViolinPlot
                    data={kdes[i].filter((d) => d.value >= dLo && d.value <= dHi)}
                    stroke={s.color}
                    strokeWidth={1.5}
                    fill={s.color}
                    fillOpacity={0.12}
                    valueScale={y}
                    width={band * 0.9}
                    left={-band * 0.45}
                    horizontal={false}
                    count={(d) => d.density}
                    value={(d) => d.value}
                  />
                  <BoxPlot
                    min={st.min}
                    max={st.max}
                    left={-band * 0.12}
                    firstQuartile={st.firstQuartile}
                    thirdQuartile={st.thirdQuartile}
                    median={st.median}
                    boxWidth={band * 0.24}
                    fill={tok("bg")}
                    fillOpacity={1}
                    stroke={tok("text-dim")}
                    strokeWidth={1}
                    valueScale={y}
                  />
                </>
              ) : (
                <>
                  {s.values.map((v, j) => (
                    <circle
                      key={j}
                      cx={jitter(j, i) * band * 0.5}
                      cy={y(v)}
                      r={3}
                      fill={s.color}
                      fillOpacity={0.6}
                      stroke={s.color}
                    />
                  ))}
                  <line
                    x1={-band * 0.3}
                    x2={band * 0.3}
                    y1={y(st.median)}
                    y2={y(st.median)}
                    stroke={tok("text")}
                    strokeWidth={2}
                  />
                </>
              )}
            </Group>
          );
        })}
      </g>
    </ChartSvg>
  );
}
