"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { Button, PageHeader } from "@/components/ui";
import { HealthBanner } from "@/components/shell/health";
import { PipelinePanel } from "./PipelinePanel";
import { RefreshPanel } from "./RefreshPanel";
import { ServingPanel } from "./ServingPanel";
import { BulkScrapePanel } from "./BulkScrapePanel";

/**
 * Data ops: is the data current, and the controls that make it current.
 * Every panel owns its loading/error state, so a failing backend call never
 * hides the controls used to recover from it.
 */
export function OpsPage() {
  const { t, fmt } = useLocale();
  const status = useOpsStatus();
  const generatedAt = status.data?.generated_at;

  return (
    <>
      <PageHeader
        title={t("ops.title")}
        description={t("ops.description")}
        actions={
          <Button size="sm" onClick={() => status.refetch()} loading={status.isFetching}>
            {t("ops.reloadStatus")}
          </Button>
        }
        meta={
          generatedAt ? (
            <time dateTime={generatedAt} title={fmt.dateTime(generatedAt)}>
              {t("ops.asOf", { time: fmt.dateTime(generatedAt) })}
            </time>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-6">
        <HealthBanner variant="full" />
        <div className="grid gap-6 xl:grid-cols-2">
          <PipelinePanel />
          <RefreshPanel />
        </div>
        <ServingPanel />
        <BulkScrapePanel />
      </div>
    </>
  );
}
