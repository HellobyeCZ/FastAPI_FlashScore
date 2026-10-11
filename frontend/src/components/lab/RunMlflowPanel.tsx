"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Checkbox,
  ConfirmDialog,
  KeyValue,
  Panel,
  Skeleton,
  TextLink
} from "@/components/ui";
import { useMlflowRuns, useRegisterRun } from "@/hooks/useMlflow";
import { errorMessage } from "@/lib/api/http";
import { routes } from "@/lib/routes";
import { isActiveRun, type BacktestRunDetail } from "@/lib/lab/backtests";
import { runWindow } from "@/lib/lab/format";
import type { MlflowRun, RegisterResponse } from "@/types/mlflow";
import { MlflowStatusCallout } from "./MlflowStatusCallout";

/**
 * The run's MLflow side: deep link, registered versions, and — when the run
 * logged its fitted model — "Register model" (optionally as @challenger).
 */
export function RunMlflowPanel({ run }: { run: BacktestRunDetail }) {
  const { t } = useLocale();
  const runs = useMlflowRuns({ purpose: "walk_forward_backtest" });
  const { refetch } = runs;
  const wasActive = useRef(isActiveRun(run));
  // A run is logged to MLflow as it completes: look again once it finishes.
  useEffect(() => {
    if (wasActive.current && !isActiveRun(run)) void refetch();
    wasActive.current = isActiveRun(run);
  }, [run, refetch]);
  const status = runs.data?.status;
  const tracked = runs.data?.runs.find(
    (r) => r.backtest_run_id === run.id || (run.mlflow_run_id !== null && r.run_id === run.mlflow_run_id)
  );
  const link = run.mlflow_ui_url ?? tracked?.ui_url ?? null;

  return (
    <Panel
      title={t("common.mlflow")}
      description={t("lab.detail.mlflow.description")}
      actions={
        link ? (
          <ButtonLink href={link} external size="sm">
            {t("common.openInMlflow")}
          </ButtonLink>
        ) : undefined
      }
    >
      {runs.isLoading ? (
        <Skeleton lines={3} />
      ) : runs.isError ? (
        <Callout
          tone="neg"
          title={t("lab.detail.mlflow.error")}
          action={
            <Button size="sm" onClick={() => runs.refetch()} loading={runs.isFetching}>
              {t("common.retry")}
            </Button>
          }
        >
          {errorMessage(runs.error)}
        </Callout>
      ) : status && !(status.enabled && status.reachable) ? (
        <MlflowStatusCallout status={status} onRetry={() => runs.refetch()} retrying={runs.isFetching} />
      ) : tracked ? (
        <TrackedRun run={run} tracked={tracked} />
      ) : (
        <p className="text-body text-text-dim">
          {run.mlflow_run_id ? t("lab.detail.mlflow.notFound") : t("lab.detail.mlflow.notLogged")}
        </p>
      )}
    </Panel>
  );
}

function TrackedRun({ run, tracked }: { run: BacktestRunDetail; tracked: MlflowRun }) {
  const { t, fmt, locale } = useLocale();
  const register = useRegisterRun();
  const [open, setOpen] = useState(false);
  const [asChallenger, setAsChallenger] = useState(false);
  const [done, setDone] = useState<RegisterResponse | null>(null);
  const registeredName = `picks-${tracked.model_name ?? run.model}`;

  function close() {
    if (register.isPending) return;
    setOpen(false);
    register.reset();
  }

  function confirm() {
    register.mutate(
      { run_id: tracked.run_id, alias: asChallenger ? "challenger" : null },
      {
        onSuccess: (res) => {
          setDone(res);
          setOpen(false);
          setAsChallenger(false);
        }
      }
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <KeyValue
        cols={2}
        items={[
          { label: t("lab.detail.mlflow.runName"), value: tracked.run_name ?? tracked.run_id.slice(0, 8) },
          { label: t("lab.detail.mlflow.logged"), value: fmt.dateTime(tracked.start_time) },
          {
            label: t("lab.detail.mlflow.model"),
            value: tracked.has_model ? t("lab.detail.mlflow.modelLogged") : t("lab.detail.mlflow.modelMissing")
          },
          {
            label: t("lab.detail.mlflow.versions"),
            value:
              tracked.registered_versions.length > 0 ? (
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {tracked.registered_versions.map((v) => (
                    <Badge key={`${v.name}-${v.version}`} tone="accent" title={v.name}>
                      v{v.version}
                    </Badge>
                  ))}
                </span>
              ) : (
                t("common.none")
              )
          }
        ]}
      />

      {done && (
        <Callout
          tone="info"
          title={t("lab.register.done", { name: done.name, version: done.version })}
          action={<TextLink href={routes.registry(locale)}>{t("lab.register.openRegistry")}</TextLink>}
        >
          {done.alias ? t("lab.register.doneAlias", { alias: done.alias }) : t("lab.register.doneNoAlias")}
        </Callout>
      )}

      {!tracked.has_model ? (
        <p className="text-meta text-text-faint">{t("lab.register.noModel")}</p>
      ) : run.status !== "completed" ? (
        <p className="text-meta text-text-faint">{t("lab.register.notCompleted")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t("lab.register.open")}
          </Button>
          <span className="text-meta text-text-faint">{t("lab.register.hint", { name: registeredName })}</span>
        </div>
      )}

      <ConfirmDialog
        open={open}
        onClose={close}
        onConfirm={confirm}
        title={t("lab.register.title", { name: registeredName })}
        confirmLabel={t("lab.register.confirm")}
        busy={register.isPending}
        error={register.error ? errorMessage(register.error) : null}
      >
        <p>{t("lab.register.body", { name: registeredName })}</p>
        <p className="text-text">
          {t("lab.register.evidence", {
            roi: fmt.pct(run.total_bets ? run.roi : null, 1, true),
            bets: fmt.int(run.total_bets),
            window: runWindow(run, locale, t)
          })}
        </p>
        <Checkbox
          label={t("lab.register.asChallenger")}
          hint={t("lab.register.asChallenger.hint")}
          checked={asChallenger}
          onChange={setAsChallenger}
          disabled={register.isPending}
        />
      </ConfirmDialog>
    </div>
  );
}
