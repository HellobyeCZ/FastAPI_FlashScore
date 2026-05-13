"use client";
import { useQuery } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import { Chip } from "@/components/terminal/Chip";

type Snap = {
  fetchedAt: string;
  rowCount: number;
  bookmakerCount: number;
  marketCount: number;
};

function formatChipLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  const date = d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

export function SnapshotStrip({
  eventId,
  selectedId,
  onSelect
}: {
  eventId: string;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const { data } = useQuery<Snap[]>({
    queryKey: ["snapshots", eventId],
    queryFn: async () => {
      const r = await fetch(`/api/snapshots/${eventId}`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!eventId,
    staleTime: 30_000
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
      <Kicker>Snapshots · {data.length}</Kicker>
      <Chip selected={!selectedId} onClick={() => onSelect(undefined)}>
        live
      </Chip>
      {data.map((s) => (
        <Chip
          key={s.fetchedAt}
          selected={selectedId === s.fetchedAt}
          onClick={() => onSelect(s.fetchedAt)}
        >
          {formatChipLabel(s.fetchedAt)} · {s.bookmakerCount}b/{s.marketCount}m
        </Chip>
      ))}
    </div>
  );
}
