"use client";
import { useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  ConfirmDialog,
  EmptyState,
  KeyValue,
  ModelName,
  PageHeader,
  Panel,
  SampleSize,
  Signed,
  Skeleton,
  Table,
  TextLink,
  type Column
} from "@/components/ui";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { useDeleteAlias, useRegistry, useSetAlias } from "@/hooks/useMlflow";
import { errorMessage } from "@/lib/api/http";
import { modelLabel, type Tone } from "@/lib/labels";
import { routes } from "@/lib/routes";
import type { MessageKey } from "@/lib/i18n";
import type { ModelVersion, RegisteredModel, RegistryAlias } from "@/types/mlflow";
import type { ServedModel } from "@/types/ops";
import { utcDate } from "@/lib/lab/format";
import {
  MIN_PROMOTION_BETS,
  aliasVersion,
  servingState,
  sortVersions,
  useReloadServedModels,
  versionMetric,
  type ServingState
} from "@/lib/lab/serving";
import { LabTabs } from "./LabTabs";
import { MlflowStatusCallout } from "./MlflowStatusCallout";
import { PurposeBadge } from "./ExperimentsPage";

const ALIASES: RegistryAlias[] = ["champion", "challenger"];

const STATE_TONE: Record<ServingState, Tone> = {
  synced: "pos",
  stale: "warn",
  orphaned: "warn",
  fallback: "neutral",
  untracked: "neutral"
};

/** Registered model versions per model, aliases, and what serving loaded. */
export function RegistryPage() {
  const { t, tp, fmt, locale } = useLocale();
  const registry = useRegistry();
  const ops = useOpsStatus();
  const status = registry.data?.status;
  const down = Boolean(status && !(status.enabled && status.reachable));
  const models = [...(registry.data?.models ?? [])].sort((a, b) => a.model_name.localeCompare(b.model_name));
  const served = ops.data?.models ?? [];
  const servedFor = (name: string) => served.find((m) => m.name === name);

  return (
    <>
      <PageHeader
        crumbs={[{ label: t("nav.lab"), href: routes.backtests(locale) }]}
        title={t("nav.lab.registry")}
        description={t("lab.reg.description")}
        meta={registry.data && !down ? tp("lab.reg.models", models.length, { n: fmt.int(models.length) }) : undefined}
      />
      <LabTabs active="registry" />

      <div className="flex flex-col gap-6">
        {down && (
          <MlflowStatusCallout status={status} onRetry={() => registry.refetch()} retrying={registry.isFetching} />
        )}

        <ServingPanel models={models} served={served} ops={ops} />

        {registry.isLoading ? (
          <Panel>
            <Skeleton lines={6} />
          </Panel>
        ) : registry.isError ? (
          <Callout
            tone="neg"
            title={t("lab.reg.error")}
            action={
              <Button size="sm" onClick={() => registry.refetch()} loading={registry.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(registry.error)}
          </Callout>
        ) : down ? null : models.length === 0 ? (
          <Panel>
            <EmptyState
              title={t("lab.reg.empty.title")}
              action={
                <>
                  <ButtonLink href={routes.backtests(locale)} variant="primary">
                    {t("lab.reg.empty.backtests")}
                  </ButtonLink>
                  <ButtonLink href={routes.experiments(locale)}>{t("nav.lab.experiments")}</ButtonLink>
                </>
              }
            >
              <ol className="flex flex-col gap-1 text-left">
                <li>1. {t("lab.reg.empty.step1")}</li>
                <li>2. {t("lab.reg.empty.step2")}</li>
                <li>3. {t("lab.reg.empty.step3")}</li>
              </ol>
            </EmptyState>
          </Panel>
        ) : (
          models.map((m) => <ModelPanel key={m.name} model={m} served={servedFor(m.model_name)} />)
        )}
      </div>
    </>
  );
}

/** What the live serving layer loaded per model, next to the registry champion. */
function ServingPanel({
  models,
  served,
  ops
}: {
  models: RegisteredModel[];
  served: ServedModel[];
  ops: ReturnType<typeof useOpsStatus>;
}) {
  const { t, fmt } = useLocale();
  const reload = useReloadServedModels();
  const [confirming, setConfirming] = useState(false);
  const names = Array.from(new Set([...served.map((s) => s.name), ...models.map((m) => m.model_name)])).sort();
  type Row = { name: string; model?: RegisteredModel; served?: ServedModel; state: ServingState };
  const rows: Row[] = names.map((name) => {
    const model = models.find((m) => m.model_name === name);
    const s = served.find((x) => x.name === name);
    return { name, model, served: s, state: servingState(model, s) };
  });

  const columns: Column<Row>[] = [
    { key: "model", header: t("common.model"), cell: (r) => <ModelName name={r.name} /> },
    {
      key: "serving",
      header: t("lab.reg.col.serving"),
      cell: (r) => <ServedLabel served={r.served} />
    },
    {
      key: "champion",
      header: t("lab.alias.champion"),
      hideBelow: "sm",
      cell: (r) =>
        r.model?.aliases.champion ? (
          <span className="font-mono">v{r.model.aliases.champion}</span>
        ) : (
          <span className="text-text-faint">—</span>
        )
    },
    {
      key: "state",
      header: t("common.status"),
      cell: (r) => (
        <Badge tone={STATE_TONE[r.state]} title={t(`lab.serving.${r.state}.title` as MessageKey)}>
          {t(`lab.serving.${r.state}` as MessageKey)}
        </Badge>
      )
    },
    {
      key: "loaded",
      header: t("lab.reg.col.loadedAt"),
      hideBelow: "md",
      cell: (r) => <span className="text-text-dim">{fmt.relative(r.served?.loaded_at)}</span>
    }
  ];

  const attention = rows.filter((r) => r.state === "stale" || r.state === "orphaned");

  return (
    <Panel
      title={t("lab.reg.serving.title")}
      description={t("lab.reg.serving.description")}
      padding="none"
      actions={
        <Button size="sm" onClick={() => setConfirming(true)}>
          {t("lab.reg.reload")}
        </Button>
      }
    >
      {ops.isLoading ? (
        <div className="p-4">
          <Skeleton lines={3} />
        </div>
      ) : ops.isError ? (
        <div className="p-4">
          <Callout
            tone="neg"
            title={t("lab.reg.serving.error")}
            action={
              <Button size="sm" onClick={() => ops.refetch()} loading={ops.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(ops.error)}
          </Callout>
        </div>
      ) : (
        <>
          {attention.length > 0 && (
            <div className="border-b border-border p-4">
              <Callout tone="warn" title={t("lab.reg.mismatch.title")}>
                {t("lab.reg.mismatch.body", { models: attention.map((r) => modelLabel(r.name, t)).join(", ") })}
              </Callout>
            </div>
          )}
          <Table
            caption={t("lab.reg.serving.caption")}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.name}
            rowClassName={(r) => (r.state === "stale" || r.state === "orphaned" ? "bg-warn/5" : undefined)}
            empty={<EmptyState compact title={t("lab.reg.serving.empty")} />}
          />
        </>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => {
          if (reload.isPending) return;
          setConfirming(false);
          reload.reset();
        }}
        onConfirm={() => reload.mutate(undefined, { onSuccess: () => setConfirming(false) })}
        title={t("lab.reg.reload.title")}
        confirmLabel={t("lab.reg.reload")}
        busy={reload.isPending}
        error={reload.error ? errorMessage(reload.error) : null}
      >
        <p>{t("lab.reg.reload.body")}</p>
      </ConfirmDialog>
    </Panel>
  );
}

function ServedLabel({ served }: { served: ServedModel | undefined }) {
  const { t } = useLocale();
  if (!served || !served.loaded) return <span className="text-text-faint">{t("lab.serving.notLoaded")}</span>;
  if (served.source === "registry") {
    return <span className="text-text">{t("lab.serving.registry", { version: served.version ?? "?" })}</span>;
  }
  return <span className="text-text-dim">{t("lab.serving.file")}</span>;
}

type PendingAction = { kind: "set" | "delete"; alias: RegistryAlias; version: ModelVersion };

function ModelPanel({ model, served }: { model: RegisteredModel; served: ServedModel | undefined }) {
  const { t, tp, fmt } = useLocale();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const versions = sortVersions(model.versions);
  const state = servingState(model, served);

  const columns: Column<ModelVersion>[] = [
    {
      key: "version",
      header: t("lab.reg.col.version"),
      sortValue: (v) => Number(v.version),
      cell: (v) => (
        <span className="flex flex-col gap-1">
          <span className="font-mono text-text">v{v.version}</span>
          <span className="flex flex-wrap gap-1 sm:hidden">
            <AliasBadges aliases={v.aliases} />
          </span>
        </span>
      )
    },
    {
      key: "aliases",
      header: t("lab.reg.col.aliases"),
      hideBelow: "sm",
      cell: (v) =>
        v.aliases.length ? (
          <span className="flex flex-wrap gap-1">
            <AliasBadges aliases={v.aliases} />
          </span>
        ) : (
          <span className="text-text-faint">—</span>
        )
    },
    {
      key: "created",
      header: t("common.created"),
      hideBelow: "lg",
      sortValue: (v) => v.created_at,
      cell: (v) => <span className="whitespace-nowrap text-text-dim">{fmt.relative(v.created_at)}</span>
    },
    {
      key: "purpose",
      header: t("lab.exp.col.purpose"),
      hideBelow: "xl",
      cell: (v) => <PurposeBadge purpose={v.purpose} />
    },
    {
      key: "roi",
      header: t("common.roi"),
      align: "right",
      hideBelow: "md",
      sortValue: (v) => versionMetric(v, "roi"),
      cell: (v) => <Signed value={versionMetric(v, "roi")} format="pct" />
    },
    {
      key: "sharpe",
      header: t("common.sharpeAdj"),
      headerTitle: t("lab.metric.sharpe.title"),
      align: "right",
      hideBelow: "lg",
      sortValue: (v) => versionMetric(v, "sharpe_adjusted"),
      cell: (v) => <Signed value={versionMetric(v, "sharpe_adjusted")} digits={3} />
    },
    {
      key: "n",
      header: t("common.bets"),
      align: "right",
      hideBelow: "md",
      sortValue: (v) => versionMetric(v, "n_bets"),
      cell: (v) => {
        const n = versionMetric(v, "n_bets");
        return n === null ? <span className="text-text-faint">—</span> : <SampleSize n={n} min={MIN_PROMOTION_BETS} />;
      }
    },
    {
      key: "brier",
      header: t("common.brier"),
      headerTitle: t("lab.metric.brier.title"),
      align: "right",
      hideBelow: "xl",
      firstDir: "asc",
      sortValue: (v) => versionMetric(v, "brier"),
      cell: (v) => fmt.num(versionMetric(v, "brier"), 3)
    },
    {
      key: "actions",
      header: <span className="sr-only">{t("common.actions")}</span>,
      align: "right",
      cell: (v) => (
        <span className="inline-flex flex-wrap justify-end gap-1">
          {ALIASES.map((alias) =>
            v.aliases.includes(alias) ? (
              <Button
                key={alias}
                size="sm"
                variant="ghost"
                onClick={() => setPending({ kind: "delete", alias, version: v })}
                aria-label={t("lab.reg.removeNamed", { alias: t(`lab.alias.${alias}`), version: v.version })}
              >
                {t(alias === "champion" ? "lab.reg.removeChampion" : "lab.reg.removeChallenger")}
              </Button>
            ) : (
              <Button
                key={alias}
                size="sm"
                variant={alias === "champion" ? "secondary" : "ghost"}
                onClick={() => setPending({ kind: "set", alias, version: v })}
                aria-label={t("lab.reg.makeNamed", { alias: t(`lab.alias.${alias}`), version: v.version })}
              >
                {t(alias === "champion" ? "lab.reg.makeChampion" : "lab.reg.makeChallenger")}
              </Button>
            )
          )}
        </span>
      )
    }
  ];

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ModelName name={model.model_name} />
          <span className="font-mono normal-case tracking-normal text-text-faint">{model.name}</span>
        </span>
      }
      description={tp("lab.reg.versions", versions.length, { n: fmt.int(versions.length) })}
      actions={
        <>
          <Badge tone={STATE_TONE[state]} title={t(`lab.serving.${state}.title` as MessageKey)}>
            {t(`lab.serving.${state}` as MessageKey)}
          </Badge>
          {model.ui_url && (
            <TextLink href={model.ui_url} external>
              {t("common.mlflow")}
            </TextLink>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!model.servable && (
          <Callout tone="info" title={t("lab.reg.notServable.title")}>
            {t(
              model.model_name === "dixon_coles" ? "lab.reg.notServable.dixonColes" : "lab.reg.notServable.body",
              { model: modelLabel(model.model_name, t) }
            )}
          </Callout>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {ALIASES.map((alias) => (
            <AliasCard key={alias} alias={alias} model={model} served={served} />
          ))}
        </div>
        <div className="-mx-4 border-t border-border">
          <Table
            caption={t("lab.reg.versions.caption", { name: model.name })}
            columns={columns}
            rows={versions}
            rowKey={(v) => v.version}
            empty={<EmptyState compact title={t("lab.reg.noVersions")} />}
          />
        </div>
      </div>

      {pending && (
        <AliasDialog model={model} served={served} action={pending} onClose={() => setPending(null)} />
      )}
    </Panel>
  );
}

function AliasBadges({ aliases }: { aliases: string[] }) {
  const { t } = useLocale();
  return (
    <>
      {aliases.map((a) => (
        <Badge key={a} tone={a === "champion" ? "pos" : a === "challenger" ? "info" : "neutral"}>
          {a === "champion" || a === "challenger" ? t(`lab.alias.${a}`) : a}
        </Badge>
      ))}
    </>
  );
}

function AliasCard({
  alias,
  model,
  served
}: {
  alias: RegistryAlias;
  model: RegisteredModel;
  served: ServedModel | undefined;
}) {
  const { t, fmt, locale } = useLocale();
  const version = aliasVersion(model, alias);
  const n = versionMetric(version, "n_bets");
  const state = servingState(model, served);
  return (
    <div
      className={clsx(
        "flex min-w-0 flex-col gap-3 border p-4",
        alias === "champion" && version ? "border-pos/40" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-sans text-label uppercase tracking-label text-text-dim">{t(`lab.alias.${alias}`)}</span>
        {version && (
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-lead text-text">v{version.version}</span>
            <span className="text-meta text-text-faint">{fmt.relative(version.created_at)}</span>
          </span>
        )}
      </div>
      {version ? (
        <>
          <KeyValue
            items={[
              {
                label: t("common.roi"),
                value: (
                  <span className="inline-flex items-baseline gap-2">
                    <Signed value={versionMetric(version, "roi")} format="pct" />
                    <SampleSize n={n} min={MIN_PROMOTION_BETS} />
                  </span>
                )
              },
              {
                label: t("common.sharpeAdj"),
                value: <Signed value={versionMetric(version, "sharpe_adjusted")} digits={3} />
              },
              { label: t("common.brier"), value: fmt.num(versionMetric(version, "brier"), 3) },
              { label: t("lab.new.trainUntil"), value: utcDate(locale, version.train_until) },
              {
                label: t("lab.reg.sourceRun"),
                value: (
                  <span className="inline-flex items-center gap-2">
                    <PurposeBadge purpose={version.purpose} />
                    {version.run_id && <span className="font-mono text-text-dim">{version.run_id.slice(0, 8)}</span>}
                  </span>
                )
              }
            ]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-meta">
            {alias === "champion" ? (
              <span className={clsx(state === "synced" ? "text-pos" : state === "untracked" ? "text-text-dim" : "text-warn")}>
                {t(`lab.serving.${state}.title` as MessageKey)}
              </span>
            ) : (
              <span className="text-text-dim">{t("lab.reg.challengerNote")}</span>
            )}
            {version.ui_url && (
              <TextLink href={version.ui_url} external>
                {t("common.openInMlflow")}
              </TextLink>
            )}
          </div>
        </>
      ) : (
        <p className="text-body text-text-dim">
          {alias === "champion"
            ? model.servable
              ? t("lab.reg.noChampion")
              : t("lab.reg.noChampionUntracked")
            : t("lab.reg.noChallenger")}
        </p>
      )}
    </div>
  );
}

/** Confirmation that states what serving does next and flags weak evidence. */
function AliasDialog({
  model,
  served,
  action,
  onClose
}: {
  model: RegisteredModel;
  served: ServedModel | undefined;
  action: PendingAction;
  onClose: () => void;
}) {
  const { t, fmt } = useLocale();
  const setAlias = useSetAlias(model.model_name);
  const deleteAlias = useDeleteAlias(model.model_name);
  const mutation = action.kind === "set" ? setAlias : deleteAlias;
  const { alias, version } = action;
  const aliasName = t(`lab.alias.${alias}`);
  const current = aliasVersion(model, alias);
  const champion = aliasVersion(model, "champion");

  function close() {
    if (mutation.isPending) return;
    onClose();
  }

  function confirm() {
    if (action.kind === "set") setAlias.mutate({ version: version.version, alias }, { onSuccess: onClose });
    else deleteAlias.mutate(alias, { onSuccess: onClose });
  }

  const servingNow =
    served?.loaded && served.source === "registry"
      ? `v${served.version ?? "?"}`
      : served?.loaded
        ? t("lab.serving.fileShort")
        : t("lab.serving.nothing");

  const consequence =
    action.kind === "set"
      ? alias === "champion"
        ? model.servable
          ? t("lab.reg.consequence.champion", { name: model.name, version: version.version, current: servingNow })
          : t("lab.reg.consequence.championUntracked", { model: modelLabel(model.model_name, t) })
        : t("lab.reg.consequence.challenger", { version: version.version })
      : alias === "champion"
        ? model.servable
          ? t("lab.reg.consequence.removeChampion", { version: version.version })
          : t("lab.reg.consequence.removeUntracked")
        : t("lab.reg.consequence.removeChallenger");

  const warnings: string[] = [];
  if (action.kind === "set") {
    const n = versionMetric(version, "n_bets");
    const roi = versionMetric(version, "roi");
    const sharpe = versionMetric(version, "sharpe_adjusted");
    if (n === null) warnings.push(t("lab.reg.warn.noEvidence"));
    else if (n < MIN_PROMOTION_BETS) warnings.push(t("lab.reg.warn.smallN", { n: fmt.int(n), min: fmt.int(MIN_PROMOTION_BETS) }));
    if (alias === "champion" && champion && champion.version !== version.version) {
      const champRoi = versionMetric(champion, "roi");
      const champSharpe = versionMetric(champion, "sharpe_adjusted");
      if (roi !== null && champRoi !== null && roi < champRoi) {
        warnings.push(
          t("lab.reg.warn.worseRoi", { value: fmt.pct(roi, 1, true), champion: fmt.pct(champRoi, 1, true), version: champion.version })
        );
      }
      if (sharpe !== null && champSharpe !== null && sharpe < champSharpe) {
        warnings.push(
          t("lab.reg.warn.worseSharpe", {
            value: fmt.signed(sharpe, 3),
            champion: fmt.signed(champSharpe, 3),
            version: champion.version
          })
        );
      }
    }
  }

  const compare = action.kind === "set" && alias === "champion" && champion && champion.version !== version.version;

  return (
    <ConfirmDialog
      open
      onClose={close}
      onConfirm={confirm}
      title={
        action.kind === "set"
          ? t("lab.reg.confirm.setTitle", { version: version.version, alias: aliasName, name: model.name })
          : t("lab.reg.confirm.removeTitle", { version: version.version, alias: aliasName })
      }
      confirmLabel={
        action.kind === "set"
          ? t(alias === "champion" ? "lab.reg.makeChampion" : "lab.reg.makeChallenger")
          : t(alias === "champion" ? "lab.reg.removeChampion" : "lab.reg.removeChallenger")
      }
      tone={action.kind === "delete" ? "danger" : "primary"}
      busy={mutation.isPending}
      error={mutation.error ? errorMessage(mutation.error) : null}
    >
      <p className="text-text">{consequence}</p>
      {action.kind === "set" && alias === "challenger" && current && current.version !== version.version && (
        <p>{t("lab.reg.consequence.replaces", { version: current.version, alias: aliasName })}</p>
      )}
      <EvidenceTable candidate={version} champion={compare ? champion : null} />
      {warnings.length > 0 && (
        <Callout tone="warn" title={t("lab.reg.warn.title")}>
          <ul className="flex flex-col gap-1">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </ConfirmDialog>
  );
}

/** Candidate (and current champion) evidence side by side. */
function EvidenceTable({ candidate, champion }: { candidate: ModelVersion; champion: ModelVersion | null }) {
  const { t, fmt, locale } = useLocale();
  const cols = champion ? [candidate, champion] : [candidate];
  const rows: { label: string; cell: (v: ModelVersion) => React.ReactNode }[] = [
    { label: t("common.roi"), cell: (v) => <Signed value={versionMetric(v, "roi")} format="pct" /> },
    { label: t("common.sharpeAdj"), cell: (v) => <Signed value={versionMetric(v, "sharpe_adjusted")} digits={3} /> },
    { label: t("common.bets"), cell: (v) => fmt.int(versionMetric(v, "n_bets")) },
    { label: t("common.brier"), cell: (v) => fmt.num(versionMetric(v, "brier"), 3) },
    { label: t("lab.new.trainUntil"), cell: (v) => utcDate(locale, v.train_until) }
  ];
  return (
    <table className="w-full border-collapse font-mono text-meta">
      <caption className="sr-only">{t("lab.reg.evidence")}</caption>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="py-1 text-left font-sans font-normal uppercase tracking-label text-text-dim">
            <span className="sr-only">{t("lab.compare.metric")}</span>
          </th>
          {cols.map((v, i) => (
            <th key={v.version} scope="col" className="py-1 text-right font-sans font-normal uppercase tracking-label text-text-dim">
              {i === 0 ? t("lab.reg.evidence.candidate", { version: v.version }) : t("lab.reg.evidence.champion", { version: v.version })}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-border">
            <th scope="row" className="py-1 text-left font-sans font-normal text-text-dim">
              {r.label}
            </th>
            {cols.map((v) => (
              <td key={v.version} className="py-1 text-right tabular-nums text-text">
                {r.cell(v)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
