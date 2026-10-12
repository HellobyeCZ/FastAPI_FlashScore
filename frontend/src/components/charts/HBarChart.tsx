"use client";

import { ChartFrame, ChartSvg, TICK_FONT, charWidth, isFiniteNumber, tok, truncate } from "./frame";
import { useChartText } from "./text";

export type HBar = {
  label: string;
  value: number;
  /** Sample size shown next to the bar. */
  n?: number;
  /** Pre-formatted value label; defaults to the locale-formatted value. */
  valueLabel?: string;
};

export type HBarChartProps = {
  bars: HBar[];
  /** Accessible summary of what the chart shows. */
  ariaLabel: string;
  width?: number;
  rowHeight?: number;
  /** Sort descending by value (default true). */
  sort?: boolean;
  /** Color by sign (pos/neg) — default true. Otherwise uses `color`. */
  signed?: boolean;
  color?: string;
  emptyLabel?: string;
  /** Formats values that have no `valueLabel` (default: locale number, 2 decimals). */
  format?: (v: number) => string;
  /** Bars with n below this are faded and their n is flagged (default 0: off). */
  minN?: number;
};

const FONT = 12;
/** Below this width labels move above their bar instead of beside it. */
const STACK_BELOW = 420;

/**
 * Horizontal bars, one row per category, diverging around zero, with the
 * value and n printed at the end of every row. Replaces the old "waterfall"
 * whose cumulative line ran across unrelated categories.
 */
export function HBarChart(props: HBarChartProps) {
  const { noData } = useChartText();
  const bars = props.bars.filter((b) => isFiniteNumber(b.value));
  const rowHeight = props.rowHeight ?? 22;
  return (
    <ChartFrame
      width={props.width}
      height={Math.max(1, bars.length) * rowHeight}
      empty={bars.length === 0}
      emptyLabel={props.emptyLabel ?? noData}
    >
      {(w) => <HBarPlot {...props} bars={bars} rowHeight={rowHeight} width={w} />}
    </ChartFrame>
  );
}

function HBarPlot({
  bars,
  ariaLabel,
  width,
  rowHeight,
  sort = true,
  signed = true,
  color = tok("cat-1"),
  format,
  minN = 0
}: HBarChartProps & { width: number; rowHeight: number }) {
  const { fmt } = useChartText();
  const fmtValue = format ?? ((v: number) => fmt.num(v, 2));
  const rows = (sort ? [...bars].sort((a, b) => b.value - a.value) : bars).map((b) => ({
    ...b,
    text: b.valueLabel ?? fmtValue(b.value),
    nText: b.n === undefined ? "" : `n = ${fmt.int(b.n)}`
  }));
  const rowText = (r: (typeof rows)[number]) => `${r.label}: ${r.text}${r.nText ? `, ${r.nText}` : ""}`;

  const cw = charWidth(FONT);
  const ncw = charWidth(TICK_FONT);
  const valueW = Math.ceil(Math.max(...rows.map((r) => r.text.length)) * cw + 8);
  const nW = Math.ceil(Math.max(0, ...rows.map((r) => r.nText.length)) * ncw + (rows.some((r) => r.nText) ? 10 : 0));
  const stacked = width < STACK_BELOW;
  const labelW = stacked ? 0 : Math.round(Math.min(220, Math.max(96, width * 0.3)));
  const plotW = Math.max(40, width - labelW - valueW - nW - (stacked ? 0 : 8));
  // Stacked rows: label line, bar, then a gap so each label reads with its own bar.
  const lineH = stacked ? 16 : 0;
  const rowH = rowHeight + lineH + (stacked ? 8 : 0);
  const height = rows.length * rowH + 4;

  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const hasNeg = rows.some((r) => r.value < 0);
  const hasPos = rows.some((r) => r.value > 0);
  // Diverging only when both signs occur; otherwise bars grow from the edge.
  const zeroX = labelW + (hasNeg && hasPos ? plotW / 2 : hasNeg ? plotW : 0);
  const scale = (hasNeg && hasPos ? plotW / 2 : plotW) / max;
  const maxLabelChars = Math.max(4, Math.floor(((stacked ? width : labelW - 8) - 2) / cw));
  const desc = rows.map(rowText).join("; ");

  return (
    <ChartSvg width={width} height={height} label={ariaLabel} desc={desc}>
      {rows.map((r, i) => {
        const top = i * rowH + 2;
        const barY = top + lineH;
        const midY = barY + rowHeight / 2;
        const w = Math.max(1, Math.abs(r.value) * scale);
        const x = r.value >= 0 ? zeroX : zeroX - w;
        const fill = signed ? (r.value >= 0 ? tok("pos") : tok("neg")) : color;
        const small = r.n !== undefined && r.n < minN;
        const label = truncate(r.label, maxLabelChars);
        return (
          <g key={`${r.label}-${i}`}>
            <title>{rowText(r)}</title>
            <text
              x={stacked ? 0 : labelW - 8}
              y={stacked ? top + 7 : midY}
              dominantBaseline="middle"
              textAnchor={stacked ? "start" : "end"}
              fill={tok("text-dim")}
              fontSize={FONT}
            >
              {label}
            </text>
            <line x1={zeroX} x2={zeroX} y1={barY} y2={barY + rowHeight} stroke={tok("border-strong")} />
            <rect
              x={x}
              y={barY + 4}
              width={w}
              height={Math.max(2, rowHeight - 8)}
              fill={fill}
              fillOpacity={small ? 0.35 : 0.85}
            />
            <text
              x={labelW + plotW + 8}
              y={midY}
              dominantBaseline="middle"
              fill={tok("text")}
              fontSize={FONT}
            >
              {r.text}
            </text>
            {r.nText && (
              <text
                x={width}
                y={midY}
                dominantBaseline="middle"
                textAnchor="end"
                fill={small ? tok("warn") : tok("text-faint")}
                fontSize={TICK_FONT}
              >
                {r.nText}
              </text>
            )}
          </g>
        );
      })}
    </ChartSvg>
  );
}
