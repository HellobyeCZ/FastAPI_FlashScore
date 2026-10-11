"use client";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { modelColor, modelLabel, BASELINE_MODELS, baseModel } from "@/lib/labels";
import { signTone } from "@/lib/format";

/** Definition list for labelled facts (run params, match metadata). */
export function KeyValue({
  items,
  className,
  cols = 1
}: {
  items: { label: React.ReactNode; value: React.ReactNode; title?: string }[];
  className?: string;
  cols?: 1 | 2 | 3;
}) {
  return (
    <dl
      className={clsx(
        "grid gap-x-6 gap-y-2",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className
      )}
    >
      {items.map((it, i) => (
        <div key={i} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border pb-1.5">
          <dt className="shrink-0 text-meta text-text-dim" title={it.title}>
            {it.label}
          </dt>
          <dd className="min-w-0 truncate text-right font-mono text-body text-text">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type SignedFormat = "units" | "pct" | "signed";

/** Number colored by sign (+ pos, − neg) with an explicit sign character. */
export function Signed({
  value,
  format = "signed",
  digits,
  className
}: {
  value: number | null | undefined;
  format?: SignedFormat;
  digits?: number;
  className?: string;
}) {
  const { fmt } = useLocale();
  const tone = signTone(value);
  const text =
    format === "units"
      ? fmt.units(value, digits ?? 2)
      : format === "pct"
        ? fmt.pct(value, digits ?? 1, true)
        : fmt.signed(value, digits ?? 3);
  return (
    <span
      className={clsx(
        "tabular-nums",
        tone === "pos" && "text-pos",
        tone === "neg" && "text-neg",
        tone === "neutral" && "text-text-dim",
        className
      )}
    >
      {text}
    </span>
  );
}

/** Model name with its categorical color swatch and a "baseline" marker. */
export function ModelName({
  name,
  index = 0,
  className,
  showBaseline = true
}: {
  name: string;
  index?: number;
  className?: string;
  showBaseline?: boolean;
}) {
  const { t } = useLocale();
  const baseline = BASELINE_MODELS.includes(baseModel(name));
  return (
    <span className={clsx("inline-flex min-w-0 items-center gap-2", className)}>
      <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: modelColor(name, index) }} />
      <span className="truncate">{modelLabel(name, t)}</span>
      {baseline && showBaseline && (
        <span className="text-label uppercase tracking-label text-text-faint">{t("model.baseline")}</span>
      )}
    </span>
  );
}

/** Small "n = 12" sample-size marker; warns below `min`. */
export function SampleSize({ n, min = 30, className }: { n: number | null | undefined; min?: number; className?: string }) {
  const { fmt, t } = useLocale();
  if (n === null || n === undefined) return null;
  const small = n < min;
  return (
    <span
      className={clsx("text-meta tabular-nums", small ? "text-warn" : "text-text-faint", className)}
      title={small ? t("common.smallSample", { n }) : undefined}
    >
      n = {fmt.int(n)}
      {small && <span aria-hidden> △</span>}
    </span>
  );
}
