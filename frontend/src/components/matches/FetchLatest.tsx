"use client";
import { useState } from "react";
import { Button, ConfirmDialog } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";
import { useFetchLatest } from "@/lib/matches/queries";

/**
 * "Fetch latest from FlashScore": the only path from this page to upstream.
 * Always confirmed, because it spends upstream requests and writes snapshots.
 * Offered only while the match is not terminal (or not stored at all).
 */
export function FetchLatest({
  eventId,
  lastFetchedAt,
  size = "sm"
}: {
  eventId: string;
  /** Newest stored snapshot, quoted in the confirmation so the cost is weighed against the age. */
  lastFetchedAt: string | null;
  size?: "sm" | "md";
}) {
  const { t, fmt } = useLocale();
  const [open, setOpen] = useState(false);
  const fetchLatest = useFetchLatest(eventId);
  const result = fetchLatest.data;

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        size={size}
        onClick={() => {
          fetchLatest.reset();
          setOpen(true);
        }}
        loading={fetchLatest.isPending}
        aria-haspopup="dialog"
      >
        <span aria-hidden>↻</span>
        {t("matches.fetch.button")}
      </Button>
      <span className="text-meta" role="status">
        {result && result.failed.length === 0 && (
          <span className="text-pos">{t("matches.fetch.done", { time: fmt.time(result.fetchedAt) })}</span>
        )}
        {result && result.failed.length > 0 && (
          <span className="text-warn">
            {t("matches.fetch.partial", {
              feeds: result.failed
                .map((f) => t(f.feed === "odds" ? "matches.fetch.feed.odds" : "matches.fetch.feed.stats"))
                .join(", "),
              message: result.failed[0].message
            })}
          </span>
        )}
      </span>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("matches.fetch.confirmTitle")}
        confirmLabel={t("matches.fetch.confirm")}
        busy={fetchLatest.isPending}
        error={
          fetchLatest.isError ? t("matches.fetch.failed", { message: errorMessage(fetchLatest.error) }) : undefined
        }
        onConfirm={() => fetchLatest.mutate(undefined, { onSuccess: () => setOpen(false) })}
      >
        <p>{t("matches.fetch.confirmBody")}</p>
        <p>
          {lastFetchedAt
            ? t("matches.fetch.confirmAge", { time: fmt.dateTime(lastFetchedAt), age: fmt.relative(lastFetchedAt) })
            : t("matches.fetch.confirmNone")}
        </p>
      </ConfirmDialog>
    </div>
  );
}
