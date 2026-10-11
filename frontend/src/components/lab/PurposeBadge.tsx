"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { Badge } from "@/components/ui";
import type { Tone } from "@/lib/labels";
import type { MessageKey } from "@/lib/i18n";

/** MLflow run purposes (the `purpose` tag), in filter order. */
export const PURPOSES = ["walk_forward_backtest", "offline_training", "scheduled_retrain", "backfill"] as const;
export type Purpose = (typeof PURPOSES)[number];

const PURPOSE_TONE: Record<Purpose, Tone> = {
  walk_forward_backtest: "accent",
  offline_training: "info",
  scheduled_retrain: "info",
  backfill: "neutral"
};

export const isPurpose = (v: string | null | undefined): v is Purpose =>
  (PURPOSES as readonly string[]).includes(v ?? "");

/** Why an MLflow run exists: backtest, training, retrain or backfill. */
export function PurposeBadge({ purpose }: { purpose: string | null }) {
  const { t } = useLocale();
  if (!purpose) return <span className="text-text-faint">—</span>;
  return (
    <Badge tone={isPurpose(purpose) ? PURPOSE_TONE[purpose] : "neutral"}>
      {isPurpose(purpose) ? t(`lab.purpose.${purpose}` as MessageKey) : purpose.replace(/_/g, " ")}
    </Badge>
  );
}
