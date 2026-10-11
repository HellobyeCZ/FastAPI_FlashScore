"use client";
import { scaleLinear } from "@visx/scale";
import { TICK_FONT, charWidth, stepDigits, tickCount, tok, truncate } from "./frame";

/** One axis tick: data value, pixel position inside the plot, display text. */
export type AxisTick = { value: number | string; pos: number; label: string };

const TITLE_FONT = 12;

/**
 * Vertical value axis drawn inside the plot group (origin = plot top-left).
 * Optional gridlines span `gridWidth`. The title is rotated along the axis;
 * tick labels never are.
 */
export function TerminalAxisLeft({
  ticks,
  height,
  gridWidth,
  title,
  titleX
}: {
  ticks: AxisTick[];
  height: number;
  gridWidth?: number;
  title?: string;
  /** x of the title's top edge, relative to the plot (negative). */
  titleX?: number;
}) {
  return (
    <g>
      {gridWidth
        ? ticks.map((t) => (
            <line key={`grid-${t.value}`} x1={0} x2={gridWidth} y1={t.pos} y2={t.pos} stroke={tok("border")} />
          ))
        : null}
      <line x1={0} x2={0} y1={0} y2={height} stroke={tok("border-strong")} />
      {ticks.map((t) => (
        <g key={`tick-${t.value}`}>
          <line x1={-4} x2={0} y1={t.pos} y2={t.pos} stroke={tok("border-strong")} />
          <text
            x={-7}
            y={t.pos}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={TICK_FONT}
            fill={tok("text-dim")}
          >
            {t.label}
          </text>
        </g>
      ))}
      {title && titleX !== undefined && (
        <text
          transform={`translate(${titleX} ${height / 2}) rotate(-90)`}
          textAnchor="middle"
          dominantBaseline="hanging"
          fontSize={TITLE_FONT}
          fontFamily="var(--font-sans)"
          fill={tok("text-dim")}
        >
          {title}
        </text>
      )}
    </g>
  );
}

/**
 * Horizontal axis at y = `top`. Numeric/time ticks are thinned until their
 * labels no longer collide and edge labels are anchored inside `bounds`.
 * Category ticks pass `maxLabelWidth`: longer labels are truncated with an
 * ellipsis and keep the full text in a <title>.
 */
export function TerminalAxisBottom({
  ticks,
  width,
  top,
  title,
  titleY,
  maxLabelWidth,
  bounds,
  labelDy = 6
}: {
  ticks: AxisTick[];
  width: number;
  top: number;
  title?: string;
  /** y of the title's top edge, relative to the plot. */
  titleY?: number;
  maxLabelWidth?: number;
  /** Horizontal limits (plot coordinates) that labels must stay within. */
  bounds?: [number, number];
  /** Extra offset per tick (e.g. staggered rows), on top of the default gap. */
  labelDy?: number | ((index: number) => number);
}) {
  const cw = charWidth(TICK_FONT);
  const shown = maxLabelWidth === undefined ? thin(ticks, cw) : ticks;
  const [lo, hi] = bounds ?? [-Infinity, Infinity];
  return (
    <g>
      <line x1={0} x2={width} y1={top} y2={top} stroke={tok("border-strong")} />
      {shown.map((t, i) => {
        const full = t.label;
        const text = maxLabelWidth === undefined ? full : truncate(full, Math.max(1, Math.floor(maxLabelWidth / cw)));
        const w = text.length * cw;
        let anchor: "start" | "middle" | "end" = "middle";
        let x = t.pos;
        if (t.pos - w / 2 < lo) {
          anchor = "start";
          x = Math.max(lo, t.pos - 2);
        } else if (t.pos + w / 2 > hi) {
          anchor = "end";
          x = Math.min(hi, t.pos + 2);
        }
        const dy = typeof labelDy === "function" ? labelDy(i) : labelDy;
        return (
          <g key={`tick-${t.value}`}>
            <line x1={t.pos} x2={t.pos} y1={top} y2={top + 4} stroke={tok("border-strong")} />
            <text
              x={x}
              y={top + 4 + dy}
              textAnchor={anchor}
              dominantBaseline="hanging"
              fontSize={TICK_FONT}
              fill={tok("text-dim")}
            >
              {text}
              {text !== full && <title>{full}</title>}
            </text>
          </g>
        );
      })}
      {title && titleY !== undefined && (
        <text
          x={width / 2}
          y={titleY}
          textAnchor="middle"
          dominantBaseline="hanging"
          fontSize={TITLE_FONT}
          fontFamily="var(--font-sans)"
          fill={tok("text-dim")}
        >
          {title}
        </text>
      )}
    </g>
  );
}

/** Keep every k-th tick so neighbouring labels are at least one glyph apart. */
function thin(ticks: AxisTick[], cw: number): AxisTick[] {
  if (ticks.length < 3) return ticks;
  const widest = Math.max(...ticks.map((t) => t.label.length)) * cw;
  const spacing = Math.abs(ticks[1].pos - ticks[0].pos) || 1;
  const k = Math.max(1, Math.ceil((widest + cw * 1.5) / spacing));
  return k === 1 ? ticks : ticks.filter((_, i) => i % k === 0);
}

/** Vertical offset of the second row of staggered category labels. */
export const STAGGER = 14;

export type CategoryLayout = { rows: 1 | 2; maxLabelWidth: number; labelDy: (index: number) => number };

/**
 * Category tick labels: one row when the widest label fits its slot, two
 * staggered rows when it fits two slots, otherwise two rows of truncated
 * labels (full text stays in each label's <title>).
 */
export function categoryLayout(labels: string[], step: number): CategoryLayout {
  const widest = Math.max(0, ...labels.map((l) => l.length)) * charWidth(TICK_FONT);
  if (labels.length < 2 || widest <= step - 6) {
    return { rows: 1, maxLabelWidth: Math.max(charWidth(TICK_FONT), step - 6), labelDy: () => 6 };
  }
  return {
    rows: 2,
    // Same-row neighbours are two slots apart.
    maxLabelWidth: Math.max(charWidth(TICK_FONT), 2 * step - 4),
    labelDy: (i) => 6 + (i % 2) * STAGGER
  };
}

/**
 * Nice linear value scale for a plot `innerH` tall, its ticks, and the pixel
 * width of the widest tick label (to size the left margin). `format` wins
 * over the default locale number with step-aware decimals.
 */
export function valueAxis(
  domain: [number, number],
  innerH: number,
  fmtNum: (v: number, digits: number) => string,
  format?: (v: number) => string,
  maxTicks = 8
) {
  // Nice to the tick count so the outermost ticks bound the plot.
  const count = tickCount(innerH, 36, maxTicks);
  const scale = scaleLinear<number>({ domain, range: [innerH, 0], nice: count });
  const values = scale.ticks(count);
  const digits = stepDigits(values.length > 1 ? values[1] - values[0] : 1);
  const label = format ?? ((v: number) => fmtNum(v, digits));
  const ticks: AxisTick[] = values.map((v) => ({ value: v, pos: scale(v), label: label(v) }));
  const labelWidth = Math.max(0, ...ticks.map((tk) => tk.label.length)) * charWidth(TICK_FONT);
  return { scale, ticks, digits, labelWidth };
}
