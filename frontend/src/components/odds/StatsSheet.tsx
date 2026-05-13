"use client";
import type { UseQueryResult } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import type { MatchStatsSummary } from "@/types/match-stats";

export function StatsSheet({ query }: { query: UseQueryResult<MatchStatsSummary, Error> }) {
  const { data, isLoading, error } = query;
  if (isLoading) return <div className="font-mono text-[12px] text-text-dim">▸ loading stats…</div>;
  if (error)
    return (
      <div className="border border-neg/40 px-3 py-2 font-mono text-[12px] text-neg">
        ▸ failed to load stats
      </div>
    );
  if (!data) return <div className="font-mono text-[12px] text-text-dim">▸ no data</div>;

  const teams =
    data.homeTeam && data.awayTeam ? `${data.homeTeam} vs ${data.awayTeam}` : data.eventId;

  return (
    <section className="flex flex-col gap-5">
      <div>
        <div className="mb-2 border-b border-border pb-1">
          <Kicker>Match</Kicker>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
          <dt className="text-text-dim">teams</dt>
          <dd className="text-text">{teams}</dd>
          {data.competition && (
            <>
              <dt className="text-text-dim">comp</dt>
              <dd className="text-text">{data.competition}</dd>
            </>
          )}
          {data.country && (
            <>
              <dt className="text-text-dim">country</dt>
              <dd className="text-text">{data.country}</dd>
            </>
          )}
          {data.status && (
            <>
              <dt className="text-text-dim">status</dt>
              <dd className="text-text">{data.status}</dd>
            </>
          )}
          {data.outcome && (
            <>
              <dt className="text-text-dim">outcome</dt>
              <dd className="text-text">{data.outcome}</dd>
            </>
          )}
        </dl>
      </div>

      {data.periods.length === 0 && (
        <div className="font-mono text-[12px] text-text-dim">▸ no period stats</div>
      )}

      {data.periods.map((period) => (
        <div key={period.name}>
          <div className="mb-2 border-b border-border pb-1">
            <Kicker>{period.name}</Kicker>
          </div>
          {period.categories.map((cat) => (
            <div key={`${period.name}:${cat.name}`} className="mb-3">
              <div className="mb-1 font-mono text-[10px] uppercase text-text-faint">{cat.name}</div>
              <dl className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-x-3 gap-y-[2px] font-mono text-[12px]">
                {cat.stats.map((stat, i) => (
                  <div key={`${stat.code ?? stat.label}:${i}`} className="contents">
                    <dt className="text-right text-pos tabular-nums">{stat.home}</dt>
                    <dd className="text-center text-text-dim">{stat.label}</dd>
                    <dd className="text-neg tabular-nums">{stat.away}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
