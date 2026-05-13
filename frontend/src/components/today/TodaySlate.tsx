"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { Chip } from "@/components/terminal/Chip";
import { StatusToken } from "@/components/terminal/StatusToken";
import { Kicker } from "@/components/terminal/Kicker";
import { useLocale } from "@/contexts/LocaleContext";
import type { TodayPick } from "@/hooks/useToday";

const EDGE_THRESHOLDS = [
  { value: 0, label: "all" },
  { value: 0.01, label: "≥1%" },
  { value: 0.03, label: "≥3%" },
  { value: 0.05, label: "≥5%" }
];

export function TodaySlate({
  picks,
  loading,
  error
}: {
  picks: TodayPick[];
  loading: boolean;
  error: boolean;
}) {
  const router = useRouter();
  const { locale } = useLocale();
  const [search, setSearch] = useState("");
  const [edgeMin, setEdgeMin] = useState(0);

  const filtered = useMemo(
    () =>
      picks.filter((p) => {
        if (p.edge < edgeMin) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !p.league.toLowerCase().includes(q) &&
            !p.homeTeam.toLowerCase().includes(q) &&
            !p.awayTeam.toLowerCase().includes(q) &&
            !p.model.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      }),
    [picks, search, edgeMin]
  );

  const columns: Column<TodayPick>[] = [
    {
      key: "time",
      header: "Time",
      render: (p) =>
        new Date(p.kickoff).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        })
    },
    { key: "league", header: "League", render: (p) => <span className="text-text-dim">{p.league}</span> },
    {
      key: "match",
      header: "Match",
      render: (p) => (
        <span className="text-text">
          {p.homeTeam} <span className="text-text-faint">—</span> {p.awayTeam}
        </span>
      )
    },
    { key: "market", header: "Market", render: (p) => p.market },
    { key: "pick", header: "Pick", render: (p) => <span className="text-accent">{p.pick}</span> },
    { key: "odds", header: "Odds", render: (p) => p.odds.toFixed(2), align: "right" },
    {
      key: "edge",
      header: "Edge",
      align: "right",
      render: (p) => {
        const v = (p.edge * 100).toFixed(1) + "%";
        const tone =
          Math.abs(p.edge) < 0.005 ? "text-text-dim" : p.edge > 0 ? "text-pos" : "text-neg";
        return (
          <span className={tone}>
            {p.edge >= 0 ? "+" : ""}
            {v}
          </span>
        );
      }
    },
    { key: "model", header: "Model", render: (p) => <span className="text-text-dim">{p.model}</span> },
    { key: "status", header: "Status", render: (p) => <StatusToken kind={p.status} /> }
  ];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <Kicker>Today · slate</Kicker>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 font-mono text-[11px] text-text-dim">
            <span className="text-text-faint">&gt;</span>
            <input
              data-search-input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter…"
              className="border-none bg-transparent px-0 py-0 text-[11px] placeholder:text-text-faint"
            />
          </div>
          <div className="flex items-center gap-1">
            {EDGE_THRESHOLDS.map((t) => (
              <Chip
                key={t.value}
                selected={edgeMin === t.value}
                onClick={() => setEdgeMin(t.value)}
              >
                {t.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>
      {error && (
        <div className="border border-neg/40 px-3 py-2 text-[12px] text-neg">
          ▸ failed to load today
        </div>
      )}
      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(p) =>
          p.eventId &&
          router.push(
            `/${locale}/matches/${p.eventId}` as unknown as Parameters<typeof router.push>[0]
          )
        }
        empty={loading ? "▸ loading…" : "▸ no open picks for today"}
      />
    </section>
  );
}
