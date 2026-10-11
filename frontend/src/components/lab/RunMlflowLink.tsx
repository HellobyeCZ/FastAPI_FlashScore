"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { TextLink } from "@/components/ui";
import { routes } from "@/lib/routes";
import type { BacktestRunSummary } from "@/lib/lab/backtests";

/**
 * Where a run lives in MLflow: the backend's deep link when it built one,
 * otherwise the in-app Experiments list, otherwise "not logged".
 */
export function RunMlflowLink({ run }: { run: Pick<BacktestRunSummary, "mlflow_ui_url" | "mlflow_run_id" | "model"> }) {
  const { t, locale } = useLocale();
  if (run.mlflow_ui_url) {
    return (
      <TextLink href={run.mlflow_ui_url} external>
        {t("lab.mlflow.open")}
      </TextLink>
    );
  }
  if (run.mlflow_run_id) {
    return (
      <TextLink href={routes.experiments(locale, { purpose: "walk_forward_backtest", model: run.model })}>
        {t("lab.mlflow.logged")}
      </TextLink>
    );
  }
  return <span className="text-text-faint">{t("lab.mlflow.notLogged")}</span>;
}
