"use client";

import { useMemo } from "react";
import { scaleLinear } from "@visx/scale";
import { modelColor } from "@/lib/labels";
import {
  ChartFrame,
  ChartSvg,
  Legend,
  Marker,
  SHAPES,
  TICK_FONT,
  charWidth,
  isFiniteNumber,
  jitter,
  stepDigits,
  tickCount,
  tok,
  type MarkerShape
} from "./frame";
import { TerminalAxisBottom, TerminalAxisLeft, type AxisTick } from "./TerminalAxis";
import { useChartText } from "./text";

export type ScatterPoint = {
  x: number;
  y: number;
  category: string;
};

interface ScatterChartProps {
  points: ScatterPoint[];
  /**
   * Color per category. Missing categories fall back to the model palette
   * (`modelColor`), so model names color consistently with every other chart.
   */
  colorByCategory?: Record<string, string>;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  ariaLabel?: string;
  /** Legend text per category (default: the category key). */
  categoryLabel?: (category: string) => string;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  /**
   * Spread of the deterministic jitter, in data units. Use it for discrete
   * values (e.g. every lost bet returns exactly −1) so stacked points stay
   * visible; readouts always show the true value.
   */
  jitterX?: number;
  jitterY?: number;
  /**
   * Fixed axis ranges. Points outside are drawn hollow at the edge and counted
   * in a note, so outliers stay visible without flattening everything else.
   */
  xDomain?: [number, number];
  yDomain?: [number, number];
  emptyLabel?: string;
}

/** Above this many points the per-point <title> readouts are skipped. */
const TITLE_LIMIT = 600;

/**
 * Point cloud colored and shaped by category. The domain is padded so points
 * at the extremes never sit on an axis line, and zero reference lines are
 * drawn when zero is in range.
 */
export function ScatterChart(props: ScatterChartProps) {
  const { noData } = useChartText();
  const height = props.height ?? 260;
  const points = useMemo(
    () => props.points.filter((p) => isFiniteNumber(p.x) && isFiniteNumber(p.y)),
    [props.points]
  );
  return (
    <ChartFrame width={props.width} height={height} empty={points.length === 0} emptyLabel={props.emptyLabel ?? noData}>
      {(w) => <ScatterPlot {...props} points={points} width={w} height={height} />}
    </ChartFrame>
  );
}

function ScatterPlot({
  points,
  colorByCategory,
  width,
  height,
  xLabel,
  yLabel,
  ariaLabel,
  categoryLabel = (c) => c,
  formatX,
  formatY,
  jitterX = 0,
  jitterY = 0,
  xDomain,
  yDomain
}: ScatterChartProps & { width: number; height: number }) {
  const { t, fmt } = useChartText();

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    points.forEach((p) => counts.set(p.category, (counts.get(p.category) ?? 0) + 1));
    return Array.from(counts.entries()).map(([key, n], i) => ({
      key,
      n,
      color: colorByCategory?.[key] || modelColor(key, i),
      shape: SHAPES[i % SHAPES.length] as MarkerShape
    }));
  }, [points, colorByCategory]);
  const style = new Map(categories.map((c) => [c.key, c]));

  const extent = (vals: number[], spread: number, fixed?: [number, number]): [number, number] => {
    if (fixed) return fixed;
    let lo = Math.min(...vals) - spread / 2;
    let hi = Math.max(...vals) + spread / 2;
    if (lo === hi) {
      const pad = Math.abs(lo) * 0.1 || 1;
      return [lo - pad, hi + pad];
    }
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
    return [lo, hi];
  };
  const [xLo, xHi] = extent(points.map((p) => p.x), jitterX, xDomain);
  const [yLo, yHi] = extent(points.map((p) => p.y), jitterY, yDomain);

  const margin = { top: 10, right: 14, bottom: 24 + (xLabel ? 20 : 0), left: 0 };
  const innerH = Math.max(40, height - margin.top - margin.bottom);
  const y = scaleLinear<number>({ domain: [yLo, yHi], range: [innerH, 0], nice: !yDomain });
  const yTickValues = y.ticks(tickCount(innerH, 36, 8));
  const yDigits = stepDigits(yTickValues.length > 1 ? yTickValues[1] - yTickValues[0] : 1);
  const fmtY = formatY ?? ((v: number) => fmt.num(v, yDigits));
  const yTicks: AxisTick[] = yTickValues.map((v) => ({ value: v, pos: y(v), label: fmtY(v) }));
  const widestY = Math.max(...yTicks.map((tk) => tk.label.length)) * charWidth(TICK_FONT);
  margin.left = Math.ceil(widestY + 12 + (yLabel ? 20 : 0));
  const innerW = Math.max(40, width - margin.left - margin.right);

  const x = scaleLinear<number>({ domain: [xLo, xHi], range: [0, innerW], nice: !xDomain });
  const xTickValues = x.ticks(tickCount(innerW, 72, 10));
  const xDigits = stepDigits(xTickValues.length > 1 ? xTickValues[1] - xTickValues[0] : 1);
  const fmtX = formatX ?? ((v: number) => fmt.num(v, xDigits));
  const xTicks: AxisTick[] = xTickValues.map((v) => ({ value: v, pos: x(v), label: fmtX(v) }));

  const [dxLo, dxHi] = x.domain();
  const [dyLo, dyHi] = y.domain();
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let offScale = 0;
  const marks = points.map((p, i) => {
    const jx = jitterX ? jitter(i, 1) * jitterX : 0;
    const jy = jitterY ? jitter(i, 2) * jitterY : 0;
    const vx = p.x + jx;
    const vy = p.y + jy;
    const outside = p.x < dxLo || p.x > dxHi || p.y < dyLo || p.y > dyHi;
    if (outside) offScale += 1;
    return { p, outside, cx: x(clamp(vx, dxLo, dxHi)), cy: y(clamp(vy, dyLo, dyHi)) };
  });

  const markSize = points.length > 400 ? 5 : 7;
  const withTitles = points.length <= TITLE_LIMIT;
  const showZeroX = dxLo < 0 && dxHi > 0;
  const showZeroY = dyLo < 0 && dyHi > 0;
  const desc = [
    categories.map((c) => `${categoryLabel(c.key)}: n = ${fmt.int(c.n)}`).join(", "),
    offScale > 0 ? t("scatter.offScale", { count: fmt.int(offScale) }) : ""
  ]
    .filter(Boolean)
    .join("; ");

  return (
    <>
      <ChartSvg width={width} height={height} label={ariaLabel ?? t("scatter.aria")} desc={desc}>
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <TerminalAxisLeft ticks={yTicks} height={innerH} gridWidth={innerW} title={yLabel} titleX={-margin.left + 2} />
          <TerminalAxisBottom
            ticks={xTicks}
            width={innerW}
            top={innerH}
            title={xLabel}
            titleY={innerH + 26}
            bounds={[-margin.left + 4, innerW + margin.right - 2]}
          />
          {showZeroY && (
            <line x1={0} x2={innerW} y1={y(0)} y2={y(0)} stroke={tok("text-faint")} strokeDasharray="3 3" />
          )}
          {showZeroX && (
            <line x1={x(0)} x2={x(0)} y1={0} y2={innerH} stroke={tok("text-faint")} strokeDasharray="3 3" />
          )}
          {marks.map(({ p, outside, cx, cy }, i) => {
            const s = style.get(p.category)!;
            return (
              <Marker
                key={i}
                shape={s.shape}
                x={cx}
                y={cy}
                size={markSize}
                fill={outside ? "none" : s.color}
                stroke={s.color}
                fillOpacity={outside ? undefined : 0.55}
                strokeWidth={1}
              >
                {withTitles && <title>{`${categoryLabel(p.category)}: ${fmtX(p.x)}, ${fmtY(p.y)}`}</title>}
              </Marker>
            );
          })}
        </g>
      </ChartSvg>
      {(categories.length > 1 || offScale > 0) && (
        <Legend
          label={t("legend")}
          items={categories.map((c) => ({
            key: c.key,
            label: categoryLabel(c.key),
            color: c.color,
            shape: c.shape,
            line: false,
            note: `n = ${fmt.int(c.n)}`
          }))}
        />
      )}
      {offScale > 0 && (
        <p className="mt-1 text-meta text-text-dim">{t("scatter.offScale", { count: fmt.int(offScale) })}</p>
      )}
    </>
  );
}
