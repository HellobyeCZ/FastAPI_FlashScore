"use client";
import { Stat } from "@/components/terminal/Stat";
import { Sparkline } from "@/components/terminal/Sparkline";
import { BucketBars } from "@/components/terminal/BucketBars";
import { Glyph } from "@/components/terminal/Glyph";
import type { TodayData } from "@/hooks/useToday";

export function HeroStrip({ data, loading }: { data?: TodayData; loading: boolean }) {
  const settled = data?.settledPicks ?? [];
  const open = data?.openPicks ?? [];
  const jobs = data?.runningJobs ?? [];

  // P&L: sum of pnlUnits across returned settled picks (last 10 — illustrative).
  const pnl30d = settled
    .filter((p) => p.pnlUnits !== undefined)
    .reduce((acc, p) => acc + (p.pnlUnits ?? 0), 0);

  const cumulative: number[] = (() => {
    let acc = 0;
    return settled.map((p) => (acc += p.pnlUnits ?? 0));
  })();

  const counts = {
    W: open.filter((p) => p.status === "WON").length,
    L: open.filter((p) => p.status === "LOST").length,
    P: open.filter((p) => p.status === "PEND" || p.status === "OPEN").length,
    V: open.filter((p) => p.status === "VOID").length
  };

  return (
    <section className="grid grid-cols-1 divide-y divide-border border border-border md:grid-cols-3 md:divide-x md:divide-y-0">
      <Stat
        label="Model P&L · trailing 30d"
        value={loading ? "—" : `${pnl30d >= 0 ? "+" : ""}${pnl30d.toFixed(1)}u`}
      >
        <Sparkline data={cumulative.length > 0 ? cumulative : [0]} width={220} height={28} />
      </Stat>
      <Stat
        label="Today · open picks"
        value={loading ? "—" : open.length}
        delta={`${counts.W}W ${counts.L}L ${counts.P}P`}
      >
        <BucketBars
          buckets={[
            { label: "W", value: counts.W, tone: "pos" },
            { label: "L", value: counts.L, tone: "neg" },
            { label: "P", value: counts.P, tone: "warn" },
            { label: "V", value: counts.V, tone: "neutral" }
          ]}
        />
      </Stat>
      <Stat
        label="Scrape queue"
        value={loading ? "—" : `${jobs.length}`}
        delta="running"
      >
        <ul className="font-mono text-[11px] text-text-dim">
          {jobs.slice(0, 3).map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <Glyph kind="item" className="text-text-faint" /> {j.competitionPath}
            </li>
          ))}
          {jobs.length === 0 && <li className="text-text-faint">— idle</li>}
        </ul>
      </Stat>
    </section>
  );
}
