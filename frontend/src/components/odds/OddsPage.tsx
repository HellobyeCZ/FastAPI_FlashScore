"use client";
import { useState } from "react";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Glyph } from "@/components/terminal/Glyph";
import { useOddsData } from "@/hooks/useOddsData";
import { useMatchStatsData } from "@/hooks/useMatchStatsData";
import { OddsSheet } from "./OddsSheet";
import { StatsSheet } from "./StatsSheet";

export function OddsPage({ initialEventId = "" }: { initialEventId?: string }) {
  const [eventId, setEventId] = useState(initialEventId);
  const [input, setInput] = useState(initialEventId);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | undefined>(undefined);
  const odds = useOddsData({ eventId, enabled: !!eventId });
  const stats = useMatchStatsData({ eventId, enabled: !!eventId });

  return (
    <>
      <PageHeader
        kicker="Odds · live lookup"
        actions={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEventId(input.trim());
            }}
            className="flex items-center gap-2 font-mono text-[12px]"
          >
            <Glyph kind="item" className="text-text-faint" />
            <input
              data-search-input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="event id"
              className="w-48 border border-border bg-bg px-2 py-1 text-[12px]"
            />
            <button
              type="submit"
              className="border border-accent px-3 py-1 text-accent hover:bg-surface"
            >
              load
            </button>
          </form>
        }
      />
      {!eventId && <p className="font-mono text-[12px] text-text-dim">▸ enter an event id to begin</p>}
      {eventId && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
          <OddsSheet
            query={odds}
            eventId={eventId}
            selectedSnapshotId={selectedSnapshotId}
            onSelectSnapshot={setSelectedSnapshotId}
          />
          <StatsSheet query={stats} />
        </div>
      )}
    </>
  );
}
