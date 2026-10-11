"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { TextLink } from "@/components/ui";
import { routes } from "@/lib/routes";
import { awaitingMlflow, isActiveRun, type BacktestRunSummary } from "@/lib/lab/backtests";

/**
 * Where a run lives in MLflow: the backend's deep link when it built one,
 * otherwise the in-app Experiments list for the model (any purpose, so
 * backfilled runs are included), otherwise "not logged". Runs are logged
 * just after they finish, so active and just-finished runs show a dash.
 */
export function RunMlflowLink({
  run
}: {
  run: Pick<BacktestRunSummary, "mlflow_ui_url" | "mlflow_run_id" | "model" | "status" | "finished_at">;
}) {
  const { t, locale } = useLocale();
  if (run.mlflow_ui_url) {
    return (
      <TextLink href={run.mlflow_ui_url} external className="whitespace-nowrap">
        {t("lab.mlflow.open")}
      </TextLink>
    );
  }
  if (run.mlflow_run_id) {
    return (
      <TextLink href={routes.experiments(locale, { model: run.model })} className="whitespace-nowrap">
        {t("lab.mlflow.logged")}
      </TextLink>
    );
  }
  if (isActiveRun(run) || awaitingMlflow(run)) return <span className="text-text-faint">—</span>;
  return <span className="whitespace-nowrap text-text-faint">{t("lab.mlflow.notLogged")}</span>;
}
