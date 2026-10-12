"use client";

import { scaleBand } from "@visx/scale";
import {
  ChartFrame,
  ChartSvg,
  Legend,
  TICK_FONT,
  charWidth,
  isFiniteNumber,
  stepDigits,
  tickCount,
  tok,
  type LegendItem
} from "./frame";
import {
  STAGGER,
  TerminalAxisBottom,
  TerminalAxisLeft,
  categoryLayout,
  valueAxis,
  type AxisTick
} from "./TerminalAxis";
import { useChartText } from "./text";

export type Bin = {
  label: string;
  value: number | null;
  n: number;
  /** Optional 95% interval. */
  ciLow?: number | null;
  ciHigh?: number | null;
  /** Optional reference value (e.g. expected ROI implied by edge). */
  expected?: number | null;
};

export type BinnedBarChartProps = {
  bins: Bin[];
  ariaLabel: string;
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  /** Formats y tick + value labels (default: locale number). */
  format?: (v: number) => string;
  /** Bins with n below this are drawn faded with a dashed outline and a flagged n. */
  minN?: number;
  emptyLabel?: string;
  /** Color bars by sign (pos/neg) — default true. Otherwise uses `color`. */
  signed?: boolean;
  color?: string;
};

/**
 * Vertical bars per bin with CI whiskers and n labels — for "ROI by edge
 * decile", "hit rate by price bucket", reliability-style summaries.
 */
export function BinnedBarChart(props: BinnedBarChartProps) {
  const { noData } = useChartText();
  const height = props.height ?? 240;
  const empty = !props.bins.some((b) => isFiniteNumber(b.value));
  return (
    <ChartFrame width={props.width} height={height} empty={empty} emptyLabel={props.emptyLabel ?? noData}>
      {(w) => <BinnedPlot {...props} width={w} height={height} />}
    </ChartFrame>
  );
}

function BinnedPlot({
  bins,
  ariaLabel,
  width,
  height,
  xLabel,
  yLabel,
  format,
  minN = 10,
  signed = true,
  color = tok("cat-1")
}: BinnedBarChartProps & { width: number; height: number }) {
  const { t, fmt } = useChartText();
  const vals = bins
    .flatMap((b) => [b.value, b.ciLow, b.ciHigh, b.expected])
    .filter((v): v is number => isFiniteNumber(v));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const domain: [number, number] = lo === hi ? [lo, lo + 1] : [lo, hi];

  // Bottom rows: bin label (one or two staggered rows), n, optional axis title.
  const top = 10;
  const right = 8;
  const yTitle = yLabel ? 20 : 0;
  const labels = bins.map((b) => b.label);
  const bandFor = (w: number) =>
    scaleBand<string>({ domain: bins.map((_, i) => String(i)), range: [0, Math.max(40, w)], padding: 0.2 });
  let innerH = Math.max(40, height - top - 38 - (xLabel ? 20 : 0));
  let axis = valueAxis(domain, innerH, fmt.num, format, 6);
  let left = Math.ceil(axis.labelWidth + 12 + yTitle);
  if (categoryLayout(labels, bandFor(width - left - right).step()).rows === 2) {
    innerH = Math.max(40, innerH - STAGGER);
    axis = valueAxis(domain, innerH, fmt.num, format, 6);
    left = Math.max(left, Math.ceil(axis.labelWidth + 12 + yTitle));
  }
  const y = axis.scale;
  const [yLo, yHi] = y.domain();
  const fmtValue = format ?? ((v: number) => fmt.num(v, Math.max(2, axis.digits)));
  const innerW = Math.max(40, width - left - right);
  const x = bandFor(innerW);
  const band = x.bandwidth();
  const step = x.step();
  const layout = categoryLayout(labels, step);
  const extraRow = (layout.rows - 1) * STAGGER;
  const barW = Math.max(3, band);
  const xTicks: AxisTick[] = bins.map((b, i) => ({ value: String(i), pos: (x(String(i)) ?? 0) + band / 2, label: b.label }));
  // n labels drop the "n =" prefix when bins are too narrow for it.
  const nWide = bins.every((b) => `n = ${fmt.int(b.n)}`.length * charWidth(TICK_FONT) < step - 4);

  const binText = (b: Bin) =>
    t("binned.bar", { label: b.label, value: isFiniteNumber(b.value) ? fmtValue(b.value) : "—", n: fmt.int(b.n) }) +
    (isFiniteNumber(b.ciLow) && isFiniteNumber(b.ciHigh)
      ? ` (${t("binned.ci")} ${fmtValue(b.ciLow)} – ${fmtValue(b.ciHigh)})`
      : "") +
    (isFiniteNumber(b.expected) ? `, ${t("binned.expected")} ${fmtValue(b.expected)}` : "");

  const hasCi = bins.some((b) => isFiniteNumber(b.ciLow) && isFiniteNumber(b.ciHigh));
  const hasExpected = bins.some((b) => isFiniteNumber(b.expected));
  const hasSmall = bins.some((b) => b.n < minN);
  const legend: LegendItem[] = [
    ...(hasCi ? [{ key: "ci", label: t("binned.ci"), color: tok("text"), line: true }] : []),
    ...(hasExpected ? [{ key: "exp", label: t("binned.expected"), color: tok("info"), dash: "3 2" }] : [])
  ];

  return (
    <>
      <ChartSvg width={width} height={height} label={ariaLabel} desc={bins.map(binText).join("; ")}>
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
          {!nWide && (
            <text
              x={-8}
              y={innerH + 24 + extraRow}
              textAnchor="end"
              dominantBaseline="hanging"
              fontSize={TICK_FONT}
              fill={tok("text-faint")}
            >
              n
            </text>
          )}
          {yLo < 0 && yHi > 0 && <line x1={0} x2={innerW} y1={y(0)} y2={y(0)} stroke={tok("border-strong")} />}
          {bins.map((b, i) => {
            const cx = (x(String(i)) ?? 0) + band / 2;
            const small = b.n < minN;
            const v = b.value;
            const fill = signed && isFiniteNumber(v) ? (v >= 0 ? tok("pos") : tok("neg")) : color;
            return (
              <g key={`${b.label}-${i}`}>
                <title>{binText(b)}</title>
                {isFiniteNumber(v) && (
                  <rect
                    x={cx - barW / 2}
                    y={Math.min(y(v), y(0))}
                    width={barW}
                    height={Math.max(1, Math.abs(y(v) - y(0)))}
                    fill={fill}
                    fillOpacity={small ? 0.25 : 0.75}
                    stroke={small ? fill : undefined}
                    strokeDasharray={small ? "3 2" : undefined}
                  />
                )}
                {isFiniteNumber(b.ciLow) && isFiniteNumber(b.ciHigh) && (
                  <g stroke={tok("text")} strokeWidth={1.5}>
                    <line x1={cx} x2={cx} y1={y(b.ciLow)} y2={y(b.ciHigh)} />
                    <line x1={cx - 4} x2={cx + 4} y1={y(b.ciLow)} y2={y(b.ciLow)} />
                    <line x1={cx - 4} x2={cx + 4} y1={y(b.ciHigh)} y2={y(b.ciHigh)} />
                  </g>
                )}
                {isFiniteNumber(b.expected) && (
                  <line
                    x1={cx - barW / 2 - 2}
                    x2={cx + barW / 2 + 2}
                    y1={y(b.expected)}
                    y2={y(b.expected)}
                    stroke={tok("info")}
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                )}
                <text
                  x={cx}
                  y={innerH + 24 + extraRow}
                  textAnchor="middle"
                  dominantBaseline="hanging"
                  fontSize={TICK_FONT}
                  fill={small ? tok("warn") : tok("text-faint")}
                >
                  {nWide ? `n = ${fmt.int(b.n)}` : fmt.int(b.n)}
                </text>
              </g>
            );
          })}
        </g>
      </ChartSvg>
      {(legend.length > 0 || hasSmall) && (
        <div className="flex flex-wrap items-center gap-x-4">
          {legend.length > 0 && <Legend label={t("legend")} items={legend} />}
          {hasSmall && <p className="mt-2 text-meta text-text-dim">{t("binned.small", { min: minN })}</p>}
        </div>
      )}
    </>
  );
}
