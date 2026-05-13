"use client";
import Link from "next/link";
import { Kicker } from "@/components/terminal/Kicker";
import { useLocale } from "@/contexts/LocaleContext";

export function ModelSnapshot() {
  const { locale } = useLocale();
  return (
    <section>
      <div className="mb-3 border-b border-border pb-2">
        <Kicker>Model · health</Kicker>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Brier", value: "0.241" },
          { label: "Log-loss", value: "0.587" },
          { label: "Samples", value: "1,204" }
        ].map((kpi) => (
          <div key={kpi.label} className="border border-border p-3">
            <Kicker>{kpi.label}</Kicker>
            <div className="mt-1 font-mono text-[20px] tabular-nums">{kpi.value}</div>
          </div>
        ))}
      </div>
      <Link
        href={
          `/${locale}/picks/health` as unknown as Parameters<typeof Link>[0]["href"]
        }
        className="mt-3 inline-block font-mono text-[11px] text-text-dim hover:text-accent"
      >
        ▸ open health
      </Link>
    </section>
  );
}
