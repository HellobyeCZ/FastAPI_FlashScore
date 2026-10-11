"use client";
import { useState } from "react";
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
import { useRegisterRun } from "@/hooks/useMlflow";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { errorMessage } from "@/lib/api/http";
import { routes } from "@/lib/routes";
import { awaitingMlflow, isActiveRun, type BacktestRunDetail } from "@/lib/lab/backtests";
import { runWindow } from "@/lib/lab/format";
import { isMlflowRunMissing, isMlflowUnavailable, useMlflowRun } from "@/lib/lab/mlflow";
import type { MlflowRun, RegisterResponse } from "@/types/mlflow";
import { MlflowStatusCallout } from "./MlflowStatusCallout";

/**
 * The run's MLflow side: deep link, registered versions, and — when the run
 * logged its fitted model — "Register model" (optionally as @challenger).
 * The run is looked up by the MLflow id the backend recorded for it, which
 * also covers backtests logged later by the backfill script.
 */
export function RunMlflowPanel({ run }: { run: BacktestRunDetail }) {
  const { t } = useLocale();
  const tracked = useMlflowRun(run.mlflow_run_id);
  const ops = useOpsStatus();
  const mlflow = ops.data?.mlflow;
  const mlflowDown = Boolean(mlflow && !(mlflow.enabled && mlflow.reachable));
  const link = run.mlflow_ui_url ?? tracked.data?.ui_url ?? null;

  let body: React.ReactNode;
  if (!run.mlflow_run_id) {
    const reason = isActiveRun(run)
      ? "lab.detail.mlflow.pending"
      : run.status !== "completed"
        ? "lab.detail.mlflow.onlyCompleted"
        : awaitingMlflow(run) && mlflow?.enabled !== false
          ? "lab.detail.mlflow.logging"
          : "lab.detail.mlflow.notLogged";
    body = <p className="text-body text-text-dim">{t(reason)}</p>;
  } else if (tracked.isLoading) {
    body = <Skeleton lines={3} />;
  } else if (tracked.data) {
    body = <TrackedRun run={run} tracked={tracked.data} />;
  } else if (isMlflowRunMissing(tracked.error)) {
    body = <p className="text-body text-text-dim">{t("lab.detail.mlflow.notFound")}</p>;
  } else if (isMlflowUnavailable(tracked.error) && mlflowDown) {
    body = <MlflowStatusCallout status={mlflow} onRetry={() => tracked.refetch()} retrying={tracked.isFetching} />;
  } else {
    body = (
      <Callout
        tone="neg"
        title={t("lab.detail.mlflow.error")}
        action={
          <Button size="sm" onClick={() => tracked.refetch()} loading={tracked.isFetching}>
            {t("common.retry")}
          </Button>
        }
      >
        {errorMessage(tracked.error)}
      </Callout>
    );
  }

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
      {body}
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
  const versions = tracked.registered_versions;

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
            value: !tracked.has_model
              ? t("lab.detail.mlflow.modelMissing")
              : versions.length > 0
                ? t("lab.detail.mlflow.modelRegistered")
                : t("lab.detail.mlflow.modelLogged")
          },
          {
            label: t("lab.detail.mlflow.versions"),
            value:
              versions.length > 0 ? (
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {versions.map((v) => (
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
      ) : versions.length > 0 ? (
        // Registering the same run again would only add a duplicate version
        // with identical evidence; promotion happens in the registry.
        !done && (
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-text-dim">
            <span>
              {t("lab.register.already", {
                versions: versions.map((v) => `${v.name} v${v.version}`).join(", ")
              })}
            </span>
            <TextLink href={routes.registry(locale)}>{t("lab.register.openRegistry")}</TextLink>
          </p>
        )
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
