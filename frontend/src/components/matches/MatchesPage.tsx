"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Facets, type Facet } from "@/components/terminal/Facets";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken, type StatusKind } from "@/components/terminal/StatusToken";
import { useScrapedMatchesData } from "@/hooks/useScrapedMatchesData";
import { useLocale } from "@/contexts/LocaleContext";
import type { ScrapedMatchSummary } from "@/types/scraped-matches";

function statusKind(raw?: string): StatusKind {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("live") || s.includes("in_play") || s.includes("running")) return "LIVE";
  if (s.includes("finished") || s.includes("ft") || s.includes("ended") || s.includes("completed"))
    return "FT";
  return "SCHED";
}

function formatKickoff(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function formatLastFetched(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function MatchesPage() {
  const router = useRouter();
  const { locale } = useLocale();
  const { data, isLoading } = useScrapedMatchesData({ enabled: true });
  const matches: ScrapedMatchSummary[] = data ?? [];

  const [countries, setCountries] = useState<string[]>([]);
  const [leagues, setLeagues] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  const facets: Facet[] = useMemo(() => {
    const counts = (extract: (m: ScrapedMatchSummary) => string) => {
      const m = new Map<string, number>();
      matches.forEach((mm) => {
        const v = extract(mm) || "—";
        m.set(v, (m.get(v) ?? 0) + 1);
      });
      return Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, label: value, count }));
    };
    return [
      {
        key: "country",
        label: "Country",
        options: counts((m) => m.country ?? "—"),
        selected: countries,
        onChange: setCountries
      },
      {
        key: "league",
        label: "League",
        options: counts((m) => m.competition ?? "—"),
        selected: leagues,
        onChange: setLeagues
      },
      {
        key: "status",
        label: "Status",
        options: counts((m) => statusKind(m.status)),
        selected: statuses,
        onChange: setStatuses
      }
    ];
  }, [matches, countries, leagues, statuses]);

  const filtered = useMemo(
    () =>
      matches.filter(
        (m) =>
          (countries.length === 0 || countries.includes(m.country ?? "—")) &&
          (leagues.length === 0 || leagues.includes(m.competition ?? "—")) &&
          (statuses.length === 0 || statuses.includes(statusKind(m.status)))
      ),
    [matches, countries, leagues, statuses]
  );

  const columns: Column<ScrapedMatchSummary>[] = [
    { key: "kickoff", header: "Kickoff", render: (m) => formatKickoff(m.startTimeUtc) },
    {
      key: "country",
      header: "Country",
      render: (m) => <span className="text-text-dim">{m.country ?? "—"}</span>
    },
    {
      key: "league",
      header: "League",
      render: (m) => <span className="text-text-dim">{m.competition ?? "—"}</span>
    },
    { key: "home", header: "Home", render: (m) => m.homeTeam ?? "—" },
    { key: "away", header: "Away", render: (m) => m.awayTeam ?? "—" },
    {
      key: "status",
      header: "Status",
      render: (m) => <StatusToken kind={statusKind(m.status)} />
    },
    {
      key: "snapshots",
      header: "Snap",
      align: "right",
      render: (m) => m.oddsSnapshotCount + m.statsSnapshotCount
    },
    {
      key: "lastFetch",
      header: "Last fetch",
      render: (m) => <span className="text-text-faint">{formatLastFetched(m.lastFetchedAt)}</span>
    }
  ];

  return (
    <>
      <PageHeader kicker="Matches · stored" />
      <div className="flex gap-6">
        <Facets facets={facets} />
        <div className="flex-1 overflow-x-auto">
          <DataTable
            columns={columns}
            rows={filtered}
            onRowClick={(m) =>
              router.push(
                `/${locale}/matches/${m.eventId}` as unknown as Parameters<typeof router.push>[0]
              )
            }
            empty={isLoading ? "▸ loading…" : "▸ no matches in db"}
          />
        </div>
      </div>
    </>
  );
}
