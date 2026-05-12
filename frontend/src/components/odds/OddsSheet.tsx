"use client";
import type { UseQueryResult } from "@tanstack/react-query";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { Kicker } from "@/components/terminal/Kicker";
import { Glyph } from "@/components/terminal/Glyph";
import type { EventOddsSummary, BookmakerOdds } from "@/types/odds";
import { SnapshotStrip } from "./SnapshotStrip";

export function OddsSheet({
  query,
  eventId,
  selectedSnapshotId,
  onSelectSnapshot
}: {
  query: UseQueryResult<EventOddsSummary, Error>;
  eventId: string;
  selectedSnapshotId?: string;
  onSelectSnapshot: (id?: string) => void;
}) {
  const { data, isLoading, error } = query;

  return (
    <section className="flex flex-col gap-5">
      <SnapshotStrip
        eventId={eventId}
        selectedId={selectedSnapshotId}
        onSelect={onSelectSnapshot}
      />
      {isLoading && <div className="font-mono text-[12px] text-text-dim">▸ loading odds…</div>}
      {error && (
        <div className="border border-neg/40 px-3 py-2 font-mono text-[12px] text-neg">
          ▸ failed to load odds
        </div>
      )}
      {!isLoading && !error && data && data.markets.length === 0 && (
        <div className="font-mono text-[12px] text-text-dim">▸ no markets returned</div>
      )}
      {data?.markets.map((market) => {
        const columns: Column<BookmakerOdds>[] = [
          {
            key: "sel",
            header: market.marketName,
            render: (r) => <span className="text-text">{r.selectionName}</span>
          },
          {
            key: "book",
            header: "Bookmaker",
            render: (r) => <span className="text-text-dim">{r.bookmakerName}</span>
          },
          {
            key: "odds",
            header: "Odds",
            align: "right",
            render: (r) => (r.odds !== null ? r.odds.toFixed(2) : <Glyph kind="null" className="text-text-faint" />)
          }
        ];
        return (
          <div key={market.marketId}>
            <div className="mb-1 flex items-baseline justify-between border-b border-border pb-1">
              <Kicker>{market.marketName}</Kicker>
              <span className="font-mono text-[10px] text-text-faint">
                {market.selections.length} rows
              </span>
            </div>
            <DataTable columns={columns} rows={market.selections} />
          </div>
        );
      })}
    </section>
  );
}
