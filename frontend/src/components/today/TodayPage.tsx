"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, PageHeader } from "@/components/ui";
import { HealthBanner } from "@/components/shell/health";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { useToday } from "@/hooks/useToday";
import { TodayKpis } from "./TodayKpis";
import { TodaySlate } from "./TodaySlate";
import { RecentSettled } from "./RecentSettled";
import { ServedModels } from "./ServedModels";

/**
 * The operator's landing page: is everything healthy (banner, KPIs, served
 * models), what is on the slate, and what settled last. Each panel owns its
 * loading / error / empty state, so one failed source never blanks the page.
 */
export function TodayPage() {
  const { t, fmt } = useLocale();
  const today = useToday();
  const ops = useOpsStatus();

  return (
    <>
      <PageHeader
        title={t("today.title")}
        description={t("today.description")}
        meta={today.data ? t("common.asOf", { time: fmt.time(today.data.generated_at) }) : undefined}
        actions={
          <Button
            size="sm"
            loading={today.isRefetching}
            onClick={() => {
              void today.refetch();
              void ops.refetch();
            }}
          >
            {t("common.refresh")}
          </Button>
        }
      />
      <div className="flex flex-col gap-6">
        <HealthBanner variant="full" />
        <TodayKpis query={today} />
        <TodaySlate query={today} />
        <ServedModels />
        <RecentSettled query={today} />
      </div>
    </>
  );
}
