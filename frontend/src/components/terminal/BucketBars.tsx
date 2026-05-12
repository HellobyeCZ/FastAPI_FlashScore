export type Bucket = { label: string; value: number; tone?: "pos" | "neg" | "neutral" | "warn" };

export function BucketBars({ buckets, height = 28 }: { buckets: Bucket[]; height?: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {buckets.map((b) => {
        const h = (b.value / max) * height;
        const color =
          b.tone === "pos" ? "var(--pos)" :
          b.tone === "neg" ? "var(--neg)" :
          b.tone === "warn" ? "var(--warn)" :
                              "var(--text-dim)";
        return (
          <div key={b.label} className="flex flex-col items-center gap-1">
            <div style={{ height: h, width: 8, background: color }} />
            <span className="font-mono text-[9px] text-text-faint">{b.label}</span>
          </div>
        );
      })}
    </div>
  );
}
