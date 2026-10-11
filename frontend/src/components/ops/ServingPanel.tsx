"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { parseDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import {
  Badge,
  ButtonLink,
  Callout,
  EmptyState,
  KeyValue,
  ModelName,
  Panel,
  QueryState,
  Skeleton,
  Table,
  type Column
} from "@/components/ui";
import type { MlflowStatus, ServedModel } from "@/types/ops";

function MlflowSection({ mlflow, now }: { mlflow: MlflowStatus; now: Date }) {
  const { t, fmt, locale } = useLocale();
  const state = !mlflow.enabled ? "disabled" : mlflow.reachable ? "reachable" : "unreachable";
  return (
    <section aria-labelledby="ops-mlflow" className="flex min-w-0 flex-col gap-3">
      <h3 id="ops-mlflow" className="font-sans text-label uppercase tracking-label text-text-dim">
        {t("ops.mlflow.title")}
      </h3>
      <KeyValue
        items={[
          {
            label: t("ops.mlflow.status"),
            value: (
              <span data-mlflow={state}>
                <Badge tone={state === "reachable" ? "pos" : state === "unreachable" ? "warn" : "neutral"}>
                  {t(`ops.mlflow.${state}`)}
                </Badge>
              </span>
            )
          },
          {
            label: t("ops.mlflow.trackingUri"),
            value: <span title={mlflow.tracking_uri ?? undefined}>{mlflow.tracking_uri ?? "—"}</span>
          },
          {
            label: t("ops.mlflow.experiment"),
            value: mlflow.experiment_id
              ? t("ops.mlflow.experimentValue", { name: mlflow.experiment_name, id: mlflow.experiment_id })
              : mlflow.experiment_name
          },
          {
            label: t("ops.mlflow.checked"),
            value: mlflow.checked_at ? (
              <time dateTime={mlflow.checked_at} title={fmt.dateTime(mlflow.checked_at)}>
                {fmt.relative(mlflow.checked_at, now)}
              </time>
            ) : (
              "—"
            )
          }
        ]}
      />
      {state === "unreachable" && (
        <Callout tone="warn" title={t("ops.mlflow.unreachableTitle")}>
          <p>{t("ops.mlflow.unreachableBody")}</p>
          <code className="mt-1 inline-block border border-border bg-bg px-1.5 py-0.5 font-mono text-text">make mlflow</code>
          {mlflow.error && <p className="mt-1 break-all text-meta text-text-faint">{mlflow.error}</p>}
        </Callout>
      )}
      {state === "disabled" && (
        <Callout tone="info" title={t("ops.mlflow.disabledTitle")}>
          {t("ops.mlflow.disabledBody")}
        </Callout>
      )}
      <div className="flex flex-wrap gap-2">
        {mlflow.ui_url && state === "reachable" && (
          <ButtonLink href={mlflow.ui_url} external size="sm">
            {t("ops.mlflow.open")}
          </ButtonLink>
        )}
        <ButtonLink href={routes.registry(locale)} size="sm">
          {t("ops.mlflow.registry")}
        </ButtonLink>
        <ButtonLink href={routes.experiments(locale)} size="sm">
          {t("ops.mlflow.experiments")}
        </ButtonLink>
      </div>
    </section>
  );
}

/** Served models (registry champion or model file) and the MLflow server behind them. */
export function ServingPanel() {
  const { t, fmt, locale } = useLocale();
  const q = useOpsStatus();

  return (
    <Panel title={t("ops.serving.title")} description={t("ops.serving.description")}>
      <QueryState
        query={q}
        errorTitle={t("ops.statusError")}
        loading={
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Skeleton lines={4} />
            <Skeleton lines={4} />
          </div>
        }
      >
        {(s) => {
          const now = parseDate(s.generated_at) ?? new Date();
          const columns: Column<ServedModel>[] = [
            {
              key: "model",
              header: t("ops.serving.col.model"),
              cell: (m) => <ModelName name={m.name} />
            },
            {
              key: "status",
              header: t("ops.serving.col.status"),
              cell: (m) => (
                <Badge tone={m.loaded ? "pos" : "neutral"}>
                  {m.loaded ? t("ops.serving.loaded") : t("ops.serving.notLoaded")}
                </Badge>
              )
            },
            {
              key: "source",
              header: t("ops.serving.col.source"),
              cell: (m) =>
                m.source === "registry" ? (
                  <span className="text-info">
                    {m.version
                      ? t("ops.serving.source.registry", { version: m.version })
                      : t("ops.serving.source.registryAny")}
                  </span>
                ) : m.source === "file" ? (
                  <span className="text-text-dim">{t("ops.serving.source.file")}</span>
                ) : (
                  <span className="text-text-faint">—</span>
                )
            },
            {
              key: "loaded",
              header: t("ops.serving.col.loaded"),
              align: "right",
              hideBelow: "sm",
              cell: (m) =>
                m.loaded_at ? (
                  <time dateTime={m.loaded_at} title={fmt.dateTime(m.loaded_at)} className="whitespace-nowrap">
                    {fmt.relative(m.loaded_at, now)}
                  </time>
                ) : (
                  <span className="text-text-faint">—</span>
                )
            }
          ];
          const noneLoaded = s.models.length > 0 && !s.models.some((m) => m.loaded);
          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                {s.models.length === 0 ? (
                  <EmptyState compact title={t("ops.serving.empty")}>
                    {t("ops.serving.emptyHint")}
                  </EmptyState>
                ) : (
                  <Table
                    caption={t("ops.serving.caption")}
                    columns={columns}
                    rows={s.models}
                    rowKey={(m) => m.name}
                    rowHref={(m) => routes.model(locale, m.name)}
                  />
                )}
                {noneLoaded && <Callout tone="warn">{t("ops.serving.noneLoaded")}</Callout>}
              </div>
              <MlflowSection mlflow={s.mlflow} now={now} />
            </div>
          );
        }}
      </QueryState>
    </Panel>
  );
}
