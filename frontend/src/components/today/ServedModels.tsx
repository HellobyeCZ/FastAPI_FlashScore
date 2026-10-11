"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { Badge, EmptyState, ModelName, Panel, QueryState, Skeleton, TextLink } from "@/components/ui";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { routes } from "@/lib/routes";
import type { ServedModel } from "@/types/ops";

/**
 * What new picks are scored with right now, straight from /ops/status:
 * each model's source (registry champion version, a file from
 * $APP_ML_MODELS_DIR, or not loaded at all).
 */
export function ServedModels({ className }: { className?: string }) {
  const { t, locale } = useLocale();
  const query = useOpsStatus();

  return (
    <Panel
      className={className}
      title={t("today.models.title")}
      description={t("today.models.description")}
      actions={
        <TextLink href={routes.registry(locale)} className="text-meta">
          {t("today.models.openRegistry")}
        </TextLink>
      }
    >
      <QueryState
        query={query}
        errorTitle={t("today.models.error")}
        isEmpty={(d) => d.models.length === 0}
        empty={
          <EmptyState compact title={t("today.models.empty")}>
            {t("today.models.emptyBody")}
          </EmptyState>
        }
        loading={<Skeleton lines={3} className="py-1" />}
      >
        {(d) => (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {d.models.map((m, i) => (
              <ServedModelItem key={m.name} model={m} index={i} />
            ))}
          </ul>
        )}
      </QueryState>
    </Panel>
  );
}

function ServedModelItem({ model, index }: { model: ServedModel; index: number }) {
  const { t, fmt } = useLocale();
  const loaded = model.loaded && model.source !== null;
  return (
    <li className="flex min-w-0 flex-col gap-2 border border-border bg-bg/40 px-3 py-2.5">
      <ModelName name={model.name} index={index} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {!loaded ? (
          <Badge tone="warn">{t("today.models.notLoaded")}</Badge>
        ) : model.source === "registry" ? (
          <Badge tone="pos">
            {model.version
              ? t("today.models.registry", { version: model.version })
              : t("today.models.registryNoVersion")}
          </Badge>
        ) : (
          <Badge>{t("today.models.file")}</Badge>
        )}
        {loaded && model.loaded_at && (
          <span className="text-meta text-text-faint" title={fmt.dateTime(model.loaded_at)}>
            {t("today.models.loadedAt", { age: fmt.relative(model.loaded_at) })}
          </span>
        )}
      </div>
    </li>
  );
}
