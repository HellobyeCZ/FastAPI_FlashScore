import { clsx } from "clsx";

/** Placeholder block shown while data loads (keeps layout stable). */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines) {
    return (
      <div className={clsx("flex flex-col gap-2", className)} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse bg-surface-3"
            style={{ width: `${70 + ((i * 37) % 30)}%` }}
          />
        ))}
      </div>
    );
  }
  return <div aria-hidden className={clsx("animate-pulse bg-surface-3", className ?? "h-4 w-full")} />;
}
