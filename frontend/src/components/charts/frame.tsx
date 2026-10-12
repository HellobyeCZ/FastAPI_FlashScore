"use client";
import { useId } from "react";
import { clsx } from "clsx";
import { EmptyState } from "@/components/ui";
import { useElementWidth } from "@/hooks/useElementWidth";

/*
 * Shared chart internals (not exported from the chart index): the measuring
 * frame, the accessible <svg> wrapper, legends, marker shapes and the small
 * numeric helpers every chart needs. Colors are always token references.
 */

export const tok = (name: string, alpha?: number) =>
  alpha === undefined ? `rgb(var(--${name}))` : `rgb(var(--${name}) / ${alpha})`;

export const FONT_MONO = "var(--font-mono)";
/** Smallest text drawn inside a chart (matches the `label` type step). */
export const TICK_FONT = 11;
/** Approximate advance of one monospace glyph at a given font size. */
export const charWidth = (fontSize = TICK_FONT) => fontSize * 0.62;

/**
 * Measures its container and renders `children(width)` once a width is known.
 * The wrapper is rendered in every state (measuring, empty, ready) so the
 * observed element never changes, and `min-w-0` keeps an SVG from widening a
 * grid/flex track it sits in. An explicit `width` is an upper bound: a
 * narrower container wins, so text keeps its real size instead of the whole
 * chart being scaled down.
 */
export function ChartFrame({
  width,
  height,
  empty,
  emptyLabel,
  className,
  children
}: {
  width?: number;
  height: number;
  empty?: boolean;
  emptyLabel: React.ReactNode;
  className?: string;
  children: (width: number) => React.ReactNode;
}) {
  const [ref, measured] = useElementWidth<HTMLDivElement>(0);
  const w = Math.floor(width === undefined ? measured : measured > 0 ? Math.min(width, measured) : width);
  return (
    <div ref={ref} className={clsx("relative w-full min-w-0", className)}>
      {empty ? (
        <EmptyState compact title={emptyLabel} />
      ) : w > 0 ? (
        children(w)
      ) : (
        <div aria-hidden style={{ height }} />
      )}
    </div>
  );
}

/**
 * <svg role="img"> named by a <title> and summarised by a <desc>. The viewBox
 * plus `max-w-full h-auto` lets an explicitly sized chart shrink instead of
 * overflowing a narrower container.
 */
export function ChartSvg({
  width,
  height,
  label,
  desc,
  className,
  children,
  ...rest
}: Omit<React.SVGProps<SVGSVGElement>, "width" | "height" | "role"> & {
  width: number;
  height: number;
  label: string;
  desc?: string;
}) {
  const id = useId();
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${id}-title`}
      aria-describedby={desc ? `${id}-desc` : undefined}
      className={clsx("block h-auto max-w-full", className)}
      fontFamily={FONT_MONO}
      {...rest}
    >
      <title id={`${id}-title`}>{label}</title>
      {desc ? <desc id={`${id}-desc`}>{desc}</desc> : null}
      {children}
    </svg>
  );
}

export type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "triangleDown" | "cross";

/** Non-color channels so series stay distinguishable without hue (WCAG 1.4.1). */
export const SHAPES: MarkerShape[] = ["circle", "square", "triangle", "diamond", "triangleDown", "cross"];
export const DASHES: (string | undefined)[] = [undefined, "7 3", "2 3", "9 3 2 3", "4 4", "1 3"];

export function Marker({
  shape,
  x,
  y,
  size,
  fill,
  stroke,
  fillOpacity,
  strokeWidth = 1.5,
  children
}: {
  shape: MarkerShape;
  x: number;
  y: number;
  /** Visual diameter in px. */
  size: number;
  fill: string;
  stroke?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  children?: React.ReactNode;
}) {
  const r = size / 2;
  const common = { fill, fillOpacity, stroke, strokeWidth: stroke ? strokeWidth : undefined };
  switch (shape) {
    case "square":
      return (
        <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} {...common}>
          {children}
        </rect>
      );
    case "triangle":
    case "triangleDown": {
      const s = shape === "triangle" ? 1 : -1;
      const pts = [
        [x, y - s * r * 1.15],
        [x + r * 1.05, y + s * r * 0.8],
        [x - r * 1.05, y + s * r * 0.8]
      ];
      return (
        <polygon points={pts.map((p) => p.join(",")).join(" ")} {...common}>
          {children}
        </polygon>
      );
    }
    case "diamond":
      return (
        <polygon
          points={`${x},${y - r * 1.25} ${x + r * 1.05},${y} ${x},${y + r * 1.25} ${x - r * 1.05},${y}`}
          {...common}
        >
          {children}
        </polygon>
      );
    case "cross": {
      const a = r * 0.95;
      return (
        <path
          d={`M${x - a},${y - a}L${x + a},${y + a}M${x - a},${y + a}L${x + a},${y - a}`}
          stroke={stroke ?? fill}
          strokeOpacity={fillOpacity}
          strokeWidth={2}
          fill="none"
        >
          {children}
        </path>
      );
    }
    default:
      return (
        <circle cx={x} cy={y} r={r} {...common}>
          {children}
        </circle>
      );
  }
}

export type LegendItem = {
  key: string;
  label: string;
  color: string;
  dash?: string;
  shape?: MarkerShape;
  /** Draw a line segment in the swatch (series), or only the marker (points). */
  line?: boolean;
  /** Optional trailing text, e.g. a count. */
  note?: string;
};

/** HTML legend under a chart: wraps on narrow screens, swatches ≥ 3px. */
export function Legend({ items, label, className }: { items: LegendItem[]; label: string; className?: string }) {
  return (
    <ul aria-label={label} className={clsx("mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-dim", className)}>
      {items.map((it) => (
        <li key={it.key} className="flex min-w-0 max-w-full items-center gap-1.5">
          <svg width={24} height={12} aria-hidden className="shrink-0">
            {it.line !== false && (
              <line x1={1} x2={23} y1={6} y2={6} stroke={it.color} strokeWidth={3} strokeDasharray={it.dash} />
            )}
            {it.shape && <Marker shape={it.shape} x={12} y={6} size={7} fill={it.color} />}
          </svg>
          <span className="truncate" title={it.label}>
            {it.label}
          </span>
          {it.note && <span className="shrink-0 text-text-faint">{it.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Decimal places that keep adjacent ticks distinct (step 0.05 → 2, 5 → 0). */
export function stepDigits(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Tick count that leaves roughly `px` pixels per tick. */
export function tickCount(length: number, px: number, max = 10): number {
  return Math.max(2, Math.min(max, Math.floor(length / px)));
}

/** Shorten to `maxChars` with an ellipsis; callers keep the full text in a <title>. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Deterministic pseudo-random value in [-0.5, 0.5) for index `i`. Jitter must
 * not use Math.random: charts render on the server too, and points would move
 * on every re-render.
 */
export function jitter(i: number, salt = 0): number {
  let x = Math.imul((i + 1) ^ Math.imul(salt + 1, 0x27d4eb2d), 0x9e3779b1);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296 - 0.5;
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
