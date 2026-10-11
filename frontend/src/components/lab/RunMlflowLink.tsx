"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { TextLink } from "@/components/ui";
import { routes } from "@/lib/routes";
import { isActiveRun, type BacktestRunSummary } from "@/lib/lab/backtests";

/**
 * Where a run lives in MLflow: the backend's deep link when it built one,
 * otherwise the in-app Experiments list, otherwise "not logged". Runs are
 * logged when they finish, so active runs show a dash.
 */
export function RunMlflowLink({
  run
}: {
  run: Pick<BacktestRunSummary, "mlflow_ui_url" | "mlflow_run_id" | "model" | "status">;
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
      <TextLink
        href={routes.experiments(locale, { purpose: "walk_forward_backtest", model: run.model })}
        className="whitespace-nowrap"
      >
        {t("lab.mlflow.logged")}
      </TextLink>
    );
  }
  if (isActiveRun(run)) return <span className="text-text-faint">—</span>;
  return <span className="whitespace-nowrap text-text-faint">{t("lab.mlflow.notLogged")}</span>;
}
