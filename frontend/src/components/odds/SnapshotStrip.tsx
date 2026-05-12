"use client";
import { useQuery } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import { Chip } from "@/components/terminal/Chip";

type Snap = { id: number; fetchedAt: string };

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
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <Kicker>Snapshots</Kicker>
      <Chip selected={!selectedId} onClick={() => onSelect(undefined)}>
        live
      </Chip>
      {data.map((s) => (
        <Chip
          key={s.id}
          selected={selectedId === String(s.id)}
          onClick={() => onSelect(String(s.id))}
        >
          {new Date(s.fetchedAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit"
          })}
        </Chip>
      ))}
    </div>
  );
}
