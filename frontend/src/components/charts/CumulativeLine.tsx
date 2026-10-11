"use client";

import { useMemo, useState } from "react";
import { scaleLinear, scaleTime } from "@visx/scale";
import { seriesColor } from "@/lib/labels";
import {
  ChartFrame,
  ChartSvg,
  DASHES,
  Legend,
  Marker,
  SHAPES,
  TICK_FONT,
  charWidth,
  isFiniteNumber,
  stepDigits,
  tickCount,
  tok,
  type MarkerShape
} from "./frame";
import { TerminalAxisBottom, TerminalAxisLeft, type AxisTick } from "./TerminalAxis";
import { useChartText } from "./text";

export type Series = {
  label: string;
  /** CSS color; empty/omitted falls back to the categorical palette by index. */
  color?: string;
  /** Points in any order; x is an index/number, or epoch ms when xType="time". */
  points: { x: number; y: number }[];
};

interface CumulativeLineChartProps {
  series: Series[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  /**
   * "index" (default) plots x as a plain number. "time" reads x as epoch
   * milliseconds and labels ticks with locale dates.
   */
  xType?: "index" | "time";
  /** Accessible name; a per-series summary is generated as the description. */
  ariaLabel?: string;
  /** Formats y ticks and readout values (default: locale number). */
  formatY?: (v: number) => string;
  /** Formats x in the readout and on ticks (default: locale integer / date). */
  formatX?: (x: number) => string;
  /** Dashed reference line at y = 0 (default true; the domain then includes 0). */
  zeroLine?: boolean;
  emptyLabel?: string;
}

type Styled = Series & { color: string; dash?: string; shape: MarkerShape };

const DAY = 86_400_000;
/** Series with at most this many points get a marker on every observation. */
const MARKER_LIMIT = 40;

export function CumulativeLineChart(props: CumulativeLineChartProps) {
  const { noData } = useChartText();
  const height = props.height ?? 240;
  const series = useMemo<Styled[]>(
    () =>
      props.series.map((s, i) => ({
        ...s,
        color: s.color || seriesColor(i),
        dash: DASHES[i % DASHES.length],
        shape: SHAPES[i % SHAPES.length],
        points: s.points.filter((p) => isFiniteNumber(p.x) && isFiniteNumber(p.y)).sort((a, b) => a.x - b.x)
      })),
    [props.series]
  );
  const empty = series.every((s) => s.points.length === 0);
  return (
    <ChartFrame width={props.width} height={height} empty={empty} emptyLabel={props.emptyLabel ?? noData}>
      {(w) => <LinePlot {...props} series={series} width={w} height={height} />}
    </ChartFrame>
  );
}

function LinePlot({
  series,
  width,
  height,
  xLabel,
  yLabel,
  xType = "index",
  ariaLabel,
  formatY,
  formatX,
  zeroLine = true
}: Omit<CumulativeLineChartProps, "series"> & { series: Styled[]; width: number; height: number }) {
  const { t, tp, locale, fmt } = useChartText();
  const [hover, setHover] = useState<number | null>(null);
  const isTime = xType === "time";

  const xs = useMemo(() => {
    const set = new Set<number>();
    series.forEach((s) => s.points.forEach((p) => set.add(p.x)));
    return Array.from(set).sort((a, b) => a - b);
  }, [series]);

  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  let yLo = Math.min(...ys, ...(zeroLine ? [0] : []));
  let yHi = Math.max(...ys, ...(zeroLine ? [0] : []));
  if (yLo === yHi) {
    const pad = Math.abs(yLo) * 0.1 || 1;
    yLo -= pad;
    yHi += pad;
  } else {
    // Headroom so extreme points don't sit on the frame; a zero baseline stays put.
    const pad = (yHi - yLo) * 0.04;
    if (yHi !== 0) yHi += pad;
    if (yLo !== 0) yLo -= pad;
  }

  const margin = { top: 10, right: 14, bottom: 24 + (xLabel ? 20 : 0), left: 0 };
  const innerH = Math.max(40, height - margin.top - margin.bottom);
  const yCount = tickCount(innerH, 36, 8);
  const yScale = scaleLinear<number>({ domain: [yLo, yHi], range: [innerH, 0], nice: yCount });
  const yTickValues = yScale.ticks(yCount);
  const yDigits = stepDigits(yTickValues.length > 1 ? yTickValues[1] - yTickValues[0] : 1);
  const fmtYTick = formatY ?? ((v: number) => fmt.num(v, yDigits));
  const fmtYValue = formatY ?? ((v: number) => fmt.num(v, Math.max(2, yDigits)));
  const yTicks: AxisTick[] = yTickValues.map((v) => ({ value: v, pos: yScale(v), label: fmtYTick(v) }));
  const widestY = Math.max(...yTicks.map((tk) => tk.label.length)) * charWidth(TICK_FONT);
  margin.left = Math.ceil(widestY + 12 + (yLabel ? 20 : 0));
  const innerW = Math.max(40, width - margin.left - margin.right);

  let xLo = xs[0];
  let xHi = xs[xs.length - 1];
  if (xLo === xHi) {
    const pad = isTime ? DAY : 1;
    xLo -= pad;
    xHi += pad;
  }
  const span = xHi - xLo;
  const readoutFmt = isTime ? readoutFormat(locale, span) : null;
  const integerX = xs.every((x) => Number.isInteger(x));
  const plainX = (x: number) => (integerX ? fmt.int(x) : fmt.num(x, stepDigits(span / 10)));
  const fmtXValue = formatX ?? ((x: number) => (readoutFmt ? readoutFmt.format(x) : plainX(x)));

  const timeScale = scaleTime<number>({ domain: [new Date(xLo), new Date(xHi)], range: [0, innerW] });
  const linScale = scaleLinear<number>({ domain: [xLo, xHi], range: [0, innerW] });
  const xPos = (x: number) => (isTime ? timeScale(new Date(x)) : linScale(x));
  const xInvert = (px: number) => (isTime ? timeScale.invert(px).getTime() : linScale.invert(px));

  const nX = tickCount(innerW, 84, 8);
  const xTickValues = isTime
    ? timeScale.ticks(nX).map((d) => d.getTime())
    : linScale.ticks(nX).filter((v) => !integerX || Number.isInteger(v));
  const fmtXTick = formatX ?? (isTime ? timeTickFormatter(locale, xTickValues) : plainX);
  const xTicks: AxisTick[] = xTickValues.map((v) => ({ value: v, pos: xPos(v), label: fmtXTick(v) }));

  const paths = series.map((s) =>
    s.points.map((p, i) => `${i === 0 ? "M" : "L"}${xPos(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`).join("")
  );

  /** Last observation at or before x (cumulative series hold their value). */
  const valueAt = (s: Styled, x: number) => {
    let found: { x: number; y: number } | null = null;
    for (const p of s.points) {
      if (p.x > x) break;
      found = p;
    }
    return found;
  };

  const nearestIndex = (x: number) => {
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(xs[lo - 1] - x) < Math.abs(xs[lo] - x)) return lo - 1;
    return lo;
  };

  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * innerW;
    setHover(nearestIndex(xInvert(Math.max(0, Math.min(innerW, px)))));
  };

  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (xs.length === 0) return;
    const last = xs.length - 1;
    const step = e.shiftKey ? 10 : 1;
    const keys: Record<string, () => number | null> = {
      ArrowRight: () => Math.min(last, (hover ?? -1) + step),
      ArrowLeft: () => Math.max(0, (hover ?? last + 1) - step),
      Home: () => 0,
      End: () => last,
      Escape: () => null
    };
    const next = keys[e.key];
    if (!next) return;
    e.preventDefault();
    setHover(next());
  };

  const hoverX = hover === null ? null : xs[hover];
  const desc = [
    xs.length > 0 ? t("line.range", { from: fmtXValue(xs[0]), to: fmtXValue(xs[xs.length - 1]) }) : "",
    ...series.map((s) => {
      const last = s.points[s.points.length - 1];
      return t("line.desc", {
        label: s.label,
        points: tp("points", s.points.length),
        value: last ? fmtYValue(last.y) : "—"
      });
    })
  ]
    .filter(Boolean)
    .join("; ");

  const showZero = zeroLine && yScale.domain()[0] <= 0 && yScale.domain()[1] >= 0;
  const readoutLeft = hoverX !== null && xPos(hoverX) > innerW / 2;

  return (
    <>
      <ChartSvg
        width={width}
        height={height}
        label={ariaLabel ?? t("line.aria")}
        desc={desc}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="touch-pan-y outline-offset-2"
      >
        <g transform={`translate(${margin.left} ${margin.top})`}>
          <TerminalAxisLeft
            ticks={yTicks}
            height={innerH}
            gridWidth={innerW}
            title={yLabel}
            titleX={-margin.left + 2}
          />
          <TerminalAxisBottom
            ticks={xTicks}
            width={innerW}
            top={innerH}
            title={xLabel}
            titleY={innerH + 26}
            bounds={[-margin.left + 4, innerW + margin.right - 2]}
          />
          {showZero && (
            <line
              x1={0}
              x2={innerW}
              y1={yScale(0)}
              y2={yScale(0)}
              stroke={tok("text-faint")}
              strokeDasharray="3 3"
            />
          )}
          {series.map((s, i) => (
            <g key={i}>
              {s.points.length > 1 && (
                <path
                  d={paths[i]}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                />
              )}
              {(s.points.length <= MARKER_LIMIT || s.points.length === 1) &&
                s.points.map((p, j) => (
                  <Marker
                    key={j}
                    shape={s.shape}
                    x={xPos(p.x)}
                    y={yScale(p.y)}
                    size={6}
                    fill={s.color}
                  />
                ))}
            </g>
          ))}
          {hoverX !== null && (
            <g pointerEvents="none">
              <line
                x1={xPos(hoverX)}
                x2={xPos(hoverX)}
                y1={0}
                y2={innerH}
                stroke={tok("text-dim")}
                strokeDasharray="2 2"
              />
              {series.map((s, i) => {
                const p = valueAt(s, hoverX);
                return p ? (
                  <circle
                    key={i}
                    cx={xPos(p.x)}
                    cy={yScale(p.y)}
                    r={4}
                    fill={tok("bg")}
                    stroke={s.color}
                    strokeWidth={2}
                  />
                ) : null;
              })}
            </g>
          )}
          <rect
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setHover(null)}
          />
        </g>
      </ChartSvg>
      {hoverX !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 max-w-[70%] border border-border-strong bg-bg/95 px-2 py-1 text-meta"
          style={readoutLeft ? { left: margin.left + 6, top: margin.top + 4 } : { right: margin.right + 6, top: margin.top + 4 }}
        >
          <div className="text-text-dim">{fmtXValue(hoverX)}</div>
          {series.map((s, i) => {
            const p = valueAt(s, hoverX);
            return (
              <div key={i} className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-3 shrink-0" style={{ background: s.color }} />
                {series.length > 1 && <span className="truncate text-text-dim">{s.label}</span>}
                <span className="ml-auto pl-2 font-mono text-text">{p ? fmtYValue(p.y) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
      {series.length > 1 && (
        <Legend
          label={t("legend")}
          items={series.map((s, i) => ({
            key: String(i),
            label: s.label,
            color: s.color,
            dash: s.dash,
            shape: s.shape
          }))}
        />
      )}
    </>
  );
}

/** The readout always names the day; spans under two days add the time. */
function readoutFormat(locale: string, span: number): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(
    locale,
    span <= 2 * DAY
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric" }
  );
}

/**
 * Tick labels at the granularity the time scale chose: year ticks show the
 * year, month ticks the month (plus the year on January and the first tick
 * when the axis crosses a year), day ticks day + month, anything finer the
 * time of day.
 */
function timeTickFormatter(locale: string, ticks: number[]): (x: number) => string {
  const dates = ticks.map((x) => new Date(x));
  const midnight = dates.every((d) => d.getHours() === 0 && d.getMinutes() === 0);
  const monthStart = midnight && dates.every((d) => d.getDate() === 1);
  const yearStart = monthStart && dates.every((d) => d.getMonth() === 0);
  const crossesYear = new Set(dates.map((d) => d.getFullYear())).size > 1;
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts);
  if (yearStart) {
    const year = f({ year: "numeric" });
    return (x) => year.format(x);
  }
  if (monthStart) {
    const month = f({ month: "short" });
    const monthYear = f({ month: "short", year: "numeric" });
    const first = ticks[0];
    return (x) => {
      const d = new Date(x);
      return crossesYear && (x === first || d.getMonth() === 0) ? monthYear.format(x) : month.format(x);
    };
  }
  if (midnight) {
    const day = f({ day: "numeric", month: "short" });
    return (x) => day.format(x);
  }
  const time = f({ hour: "2-digit", minute: "2-digit" });
  return (x) => time.format(x);
}
