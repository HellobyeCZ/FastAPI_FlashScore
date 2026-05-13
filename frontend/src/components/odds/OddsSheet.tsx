"use client";
import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import { Glyph } from "@/components/terminal/Glyph";
import type { EventOddsSummary } from "@/types/odds";
import { SnapshotStrip } from "./SnapshotStrip";

type Pivot = {
  bookmakers: string[]; // ordered bookmaker names
  selections: {
    name: string;
    odds: Array<{ value: number | null; isBest: boolean }>;
  }[];
};

function pivotMarket(selections: EventOddsSummary["markets"][number]["selections"]): Pivot {
  // Preserve first-seen order for both axes (matches the upstream order).
  const bookmakers: string[] = [];
  const selectionsOrder: string[] = [];
  // (selectionName -> bookmakerName -> odds)
  const grid = new Map<string, Map<string, number | null>>();

  for (const r of selections) {
    if (!bookmakers.includes(r.bookmakerName)) bookmakers.push(r.bookmakerName);
    if (!selectionsOrder.includes(r.selectionName)) selectionsOrder.push(r.selectionName);
    const row = grid.get(r.selectionName) ?? new Map<string, number | null>();
    if (!row.has(r.bookmakerName)) row.set(r.bookmakerName, r.odds);
    grid.set(r.selectionName, row);
  }

  // Per-selection: highlight the best (max) decimal odds.
  const out: Pivot["selections"] = selectionsOrder.map((sel) => {
    const row = grid.get(sel) ?? new Map<string, number | null>();
    const vals = bookmakers.map((b) => row.get(b) ?? null);
    let best = -Infinity;
    for (const v of vals) if (typeof v === "number" && v > best) best = v;
    return {
      name: sel,
      odds: vals.map((v) => ({ value: v, isBest: typeof v === "number" && v === best })),
    };
  });

  return { bookmakers, selections: out };
}

export function OddsSheet({
  query,
  eventId,
  selectedSnapshotId,
  onSelectSnapshot,
}: {
  query: UseQueryResult<EventOddsSummary, Error>;
  eventId: string;
  selectedSnapshotId?: string;
  onSelectSnapshot: (id?: string) => void;
}) {
  const { data, isLoading, error } = query;

  return (
    <section className="flex flex-col gap-6">
      <SnapshotStrip
        eventId={eventId}
        selectedId={selectedSnapshotId}
        onSelect={onSelectSnapshot}
      />
      {isLoading && (
        <div className="font-mono text-[12px] text-text-dim">▸ loading odds…</div>
      )}
      {error && (
        <div className="border border-neg/40 px-3 py-2 font-mono text-[12px] text-neg">
          ▸ failed to load odds
        </div>
      )}
      {!isLoading && !error && data && data.markets.length === 0 && (
        <div className="font-mono text-[12px] text-text-dim">▸ no markets returned</div>
      )}
      {data?.markets.map((market) => (
        <MarketPivot key={market.marketId} market={market} />
      ))}
    </section>
  );
}

function MarketPivot({ market }: { market: EventOddsSummary["markets"][number] }) {
  const pivot = useMemo(() => pivotMarket(market.selections), [market.selections]);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between border-b border-border pb-1">
        <Kicker>{market.marketName}</Kicker>
        <span className="font-mono text-[10px] text-text-faint">
          {pivot.selections.length} selections · {pivot.bookmakers.length} books
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-border">
              <th
                className="px-2 py-2 text-left font-sans text-[10px] uppercase text-text-dim"
                style={{ letterSpacing: "var(--track-wide)" }}
              >
                Selection
              </th>
              {pivot.bookmakers.map((b) => (
                <th
                  key={b}
                  className="px-2 py-2 text-right font-sans text-[10px] uppercase text-text-dim"
                  style={{ letterSpacing: "var(--track-wide)" }}
                >
                  {b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pivot.selections.map((sel) => (
              <tr key={sel.name} className="border-b border-border/60">
                <td className="px-2 py-1 text-text">{sel.name}</td>
                {sel.odds.map((cell, i) => (
                  <td
                    key={i}
                    className={
                      "px-2 py-1 text-right tabular-nums " +
                      (cell.value === null
                        ? "text-text-faint"
                        : cell.isBest
                          ? "text-accent"
                          : "text-text")
                    }
                  >
                    {cell.value === null ? (
                      <Glyph kind="null" className="text-text-faint" />
                    ) : (
                      cell.value.toFixed(2)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
