"use client";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken } from "@/components/terminal/StatusToken";
import { Kicker } from "@/components/terminal/Kicker";
import type { TodayPick } from "@/hooks/useToday";

export function RecentSettled({ picks, loading }: { picks: TodayPick[]; loading: boolean }) {
  const columns: Column<TodayPick>[] = [
    { key: "league", header: "League", render: (p) => <span className="text-text-dim">{p.league}</span> },
    { key: "match", header: "Match", render: (p) => `${p.homeTeam} — ${p.awayTeam}` },
    { key: "pick", header: "Pick", render: (p) => <span className="text-accent">{p.pick}</span> },
    {
      key: "pnl",
      header: "P/L",
      align: "right",
      render: (p) => {
        const v = p.pnlUnits ?? 0;
        const tone = v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-text-dim";
        return (
          <span className={tone}>
            {v >= 0 ? "+" : ""}
            {v.toFixed(2)}u
          </span>
        );
      }
    },
    { key: "status", header: "Status", render: (p) => <StatusToken kind={p.status} /> }
  ];
  return (
    <section>
      <div className="mb-3 border-b border-border pb-2">
        <Kicker>Recent · settled</Kicker>
      </div>
      <DataTable columns={columns} rows={picks} empty={loading ? "▸ loading…" : "▸ none"} />
    </section>
  );
}
