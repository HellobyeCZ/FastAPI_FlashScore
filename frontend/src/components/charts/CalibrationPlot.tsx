"use client";

import { scaleLinear } from "@visx/scale";
import type { CalibrationBucket } from "@/lib/api-picks";
import { seriesColor } from "@/lib/labels";
import { ChartFrame, ChartSvg, TICK_FONT, charWidth, isFiniteNumber, tok } from "./frame";
import { TerminalAxisBottom, TerminalAxisLeft, type AxisTick } from "./TerminalAxis";
import { useChartText } from "./text";

interface CalibrationPlotProps {
  buckets: CalibrationBucket[];
  /** Upper bound for the square plot; the chart shrinks to its container. */
  width?: number;
  height?: number;
  ariaLabel?: string;
  /** Buckets with fewer observations are faded and left out of the curve (default 10). */
  minN?: number;
  /** Below this total n no curve is drawn and a warning is shown (default 30). */
  minTotalN?: number;
  xLabel?: string;
  yLabel?: string;
  /** Mark color (default: first categorical color). */
  color?: string;
  emptyLabel?: string;
}

const Z = 1.96;
const MAX_SIDE = 440;

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(p: number, n: number, z = Z): [number, number] {
  if (n <= 0) return [0, 1];
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Reliability diagram: mean predicted probability (x) against observed hit
 * rate (y) per bucket. Point area scales with n, whiskers are Wilson 95%
 * intervals, small buckets are faded, and with too little data the curve is
 * withheld so noise is not read as (mis)calibration.
 */
export function CalibrationPlot({
  buckets,
  width,
  height,
  ariaLabel,
  minN = 10,
  minTotalN = 30,
  xLabel,
  yLabel,
  color,
  emptyLabel
}: CalibrationPlotProps) {
  const { t, tp, fmt, noData } = useChartText();
  const valid = buckets
    .filter((b) => b.n > 0 && isFiniteNumber(b.mean_pred) && isFiniteNumber(b.hit_rate))
    .sort((a, b) => a.mean_pred - b.mean_pred);
  const totalN = valid.reduce((acc, b) => acc + b.n, 0);
  const insufficient = totalN < minTotalN;
  const markColor = color ?? seriesColor(0);

  return (
    <ChartFrame
      width={width === undefined ? undefined : Math.min(width, MAX_SIDE)}
      height={height ?? 320}
      empty={valid.length === 0}
      emptyLabel={emptyLabel ?? noData}
    >
      {(frameW) => {
        const side = Math.min(frameW, width ?? MAX_SIDE);
        const margin = { top: 12, right: 14, bottom: 0, left: 44 + 20 };
        const innerW = Math.max(60, side - margin.left - margin.right);
        // Rows under the plot: tick labels, the n strip (one or two rows), title.
        const nY = 26;
        const spread = (i: number) => (i === 0 ? Infinity : valid[i].mean_pred - valid[i - 1].mean_pred);
        const nLabelW = Math.max(...valid.map((b) => fmt.int(b.n).length)) * charWidth(TICK_FONT) + 6;
        const staggered = valid.some((_, i) => spread(i) * innerW < nLabelW);
        const nRows = staggered ? 2 : 1;
        margin.bottom = nY + nRows * 14 + 26;
        const innerH = height ? Math.max(60, height - margin.top - margin.bottom) : innerW;
        const svgH = innerH + margin.top + margin.bottom;
        const x = scaleLinear<number>({ domain: [0, 1], range: [0, innerW] });
        const y = scaleLinear<number>({ domain: [0, 1], range: [innerH, 0] });
        const pctTicks = [0, 0.2, 0.4, 0.6, 0.8, 1];
        const xTicks: AxisTick[] = pctTicks.map((v) => ({ value: v, pos: x(v), label: fmt.pct(v, 0) }));
        const yTicks: AxisTick[] = pctTicks.map((v) => ({ value: v, pos: y(v), label: fmt.pct(v, 0) }));
        const maxN = Math.max(...valid.map((b) => b.n));
        const rMax = Math.max(5, Math.min(11, innerW / 28));
        const radius = (n: number) => 2.5 + (rMax - 2.5) * Math.sqrt(n / maxN);
        const curve = valid.filter((b) => b.n >= minN);
        const drawCurve = !insufficient && curve.length >= 2;

        const summary = [
          t("calibration.desc", { buckets: tp("buckets", valid.length), n: fmt.int(totalN) }),
          ...valid.map((b) => bucketText(b)),
          insufficient ? t("calibration.insufficient", { n: fmt.int(totalN), min: minTotalN }) : ""
        ]
          .filter(Boolean)
          .join("; ");

        function bucketText(b: CalibrationBucket) {
          const [lo, hi] = wilson(b.hit_rate, b.n);
          return t("calibration.bucket", {
            range: `${fmt.pct(b.lower, 0)}–${fmt.pct(b.upper, 0)}`,
            pred: fmt.pct(b.mean_pred, 1),
            obs: fmt.pct(b.hit_rate, 1),
            lo: fmt.pct(lo, 0),
            hi: fmt.pct(hi, 0),
            n: fmt.int(b.n)
          });
        }

        return (
          <div className="flex flex-col gap-2">
            {insufficient && (
              <p role="note" className="text-meta text-warn">
                {t("calibration.insufficient", { n: fmt.int(totalN), min: minTotalN })}
              </p>
            )}
            <ChartSvg width={side} height={svgH} label={ariaLabel ?? t("calibration.aria")} desc={summary}>
              <g transform={`translate(${margin.left} ${margin.top})`}>
                <TerminalAxisLeft
                  ticks={yTicks}
                  height={innerH}
                  gridWidth={innerW}
                  title={yLabel ?? t("calibration.y")}
                  titleX={-margin.left + 2}
                />
                <TerminalAxisBottom
                  ticks={xTicks}
                  width={innerW}
                  top={innerH}
                  title={xLabel ?? t("calibration.x")}
                  titleY={innerH + nY + nRows * 14 + 8}
                  bounds={[-margin.left + 24, innerW + margin.right - 2]}
                />
                <line
                  x1={x(0)}
                  y1={y(0)}
                  x2={x(1)}
                  y2={y(1)}
                  stroke={tok("text-faint")}
                  strokeDasharray="4 4"
                />
                {drawCurve && (
                  <polyline
                    points={curve.map((b) => `${x(b.mean_pred).toFixed(1)},${y(b.hit_rate).toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke={markColor}
                    strokeWidth={1.5}
                    strokeOpacity={0.8}
                  />
                )}
                {valid.map((b, i) => {
                  const [lo, hi] = wilson(b.hit_rate, b.n);
                  const faded = b.n < minN || insufficient;
                  const cx = x(b.mean_pred);
                  return (
                    <g key={i} opacity={faded ? 0.45 : 1}>
                      <title>{bucketText(b)}</title>
                      <line x1={cx} x2={cx} y1={y(lo)} y2={y(hi)} stroke={markColor} strokeWidth={1.5} />
                      <line x1={cx - 3} x2={cx + 3} y1={y(lo)} y2={y(lo)} stroke={markColor} strokeWidth={1.5} />
                      <line x1={cx - 3} x2={cx + 3} y1={y(hi)} y2={y(hi)} stroke={markColor} strokeWidth={1.5} />
                      <circle
                        cx={cx}
                        cy={y(b.hit_rate)}
                        r={radius(b.n)}
                        fill={markColor}
                        fillOpacity={faded ? 0.35 : 0.75}
                        stroke={markColor}
                        strokeWidth={1.5}
                        strokeDasharray={faded ? "2 2" : undefined}
                      />
                    </g>
                  );
                })}
                {/* n strip: one count per bucket under its x position, staggered when crowded. */}
                <text
                  x={-8}
                  y={innerH + nY}
                  textAnchor="end"
                  dominantBaseline="hanging"
                  fontSize={TICK_FONT}
                  fill={tok("text-faint")}
                >
                  n
                </text>
                {valid.map((b, i) => (
                  <text
                    key={i}
                    x={x(b.mean_pred)}
                    y={innerH + nY + (staggered && i % 2 === 1 ? 14 : 0)}
                    textAnchor="middle"
                    dominantBaseline="hanging"
                    fontSize={TICK_FONT}
                    fill={b.n < minN ? tok("warn") : tok("text-dim")}
                  >
                    {fmt.int(b.n)}
                  </text>
                ))}
              </g>
            </ChartSvg>
            <p className="text-meta text-text-dim">{t("calibration.key", { min: minN })}</p>
          </div>
        );
      }}
    </ChartFrame>
  );
}
