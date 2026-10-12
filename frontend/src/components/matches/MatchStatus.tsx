"use client";
import { clsx } from "clsx";
import { Badge, StateBadge } from "@/components/ui";
import { useLocale } from "@/contexts/LocaleContext";
import { outcomeLabel, scoreText } from "@/lib/matches/display";
import type { MatchStatusKind } from "@/types/scraped-matches";

/** Derived match status. "Unconfirmed" (kicked off, no result stored) has no shared state key. */
export function MatchStatusBadge({ status, className }: { status: MatchStatusKind; className?: string }) {
  const { t } = useLocale();
  if (status === "unconfirmed") {
    return (
      <Badge tone="warn" title={t("matches.status.unconfirmed.title")} className={className}>
        {t("matches.status.unconfirmed")}
      </Badge>
    );
  }
  return <StateBadge state={status} className={className} />;
}

/** Status badge plus the final score, or the stored outcome when no score is labelled. */
export function MatchResult({
  status,
  score,
  outcome,
  className
}: {
  status: MatchStatusKind;
  score: { home: number | string | null; away: number | string | null } | null;
  outcome: string | null;
  className?: string;
}) {
  const { t } = useLocale();
  const text = scoreText(score);
  const fallback = text ? null : outcomeLabel(outcome, t);
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <MatchStatusBadge status={status} />
      {text && (
        <span className="font-mono tabular-nums text-text" aria-label={t("matches.score.aria", { score: text })}>
          {text}
        </span>
      )}
      {fallback && <span className="text-meta text-text-dim">{fallback}</span>}
    </span>
  );
}
