export type Bucket = {
  label: string;
  /** Signed value; bar height uses |value|, label shows formatted value. */
  value: number;
  tone?: "pos" | "neg" | "neutral" | "warn";
};

function fmt(v: number, signed: boolean): string {
  if (!Number.isFinite(v)) return "—";
  const pct = v * 100;
  if (signed) return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

export function BucketBars({
  buckets,
  height = 120,
  signed = false,
}: {
  buckets: Bucket[];
  height?: number;
  /** Render +/- prefix on value labels. */
  signed?: boolean;
}) {
  if (buckets.length === 0) {
    return (
      <div className="font-mono text-[11px] text-text-faint">▸ no data</div>
    );
  }
  const max = Math.max(0.0001, ...buckets.map((b) => Math.abs(b.value)));
  const barArea = height - 36; // reserve room for value (top) + label (bottom)
  return (
    <div
      className="flex items-end gap-2"
      style={{ height, width: "100%" }}
    >
      {buckets.map((b) => {
        const mag = Math.abs(b.value);
        const h = Math.max(2, (mag / max) * barArea);
        const tone =
          b.tone ??
          (signed ? (b.value >= 0 ? "pos" : "neg") : "neutral");
        const color =
          tone === "pos"
            ? "var(--pos)"
            : tone === "neg"
              ? "var(--neg)"
              : tone === "warn"
                ? "var(--warn)"
                : "var(--accent)";
        return (
          <div
            key={b.label}
            className="flex flex-1 flex-col items-center justify-end gap-1"
            style={{ minWidth: 0 }}
          >
            <span
              className="font-mono text-[10px] tabular-nums text-text-dim"
              style={{ lineHeight: 1 }}
            >
              {fmt(b.value, signed)}
            </span>
            <div
              style={{
                height: h,
                width: "100%",
                maxWidth: 64,
                background: color,
              }}
            />
            <span
              className="font-mono text-[10px] text-text-faint"
              style={{ lineHeight: 1 }}
            >
              {b.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
