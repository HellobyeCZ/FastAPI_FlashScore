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
          <ul className="flex flex-col">
            {d.models.map((m, i) => (
              <ServedModelRow key={m.name} model={m} index={i} />
            ))}
          </ul>
        )}
      </QueryState>
    </Panel>
  );
}

function ServedModelRow({ model, index }: { model: ServedModel; index: number }) {
  const { t, fmt } = useLocale();
  const loaded = model.loaded && model.source !== null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-2 first:pt-0 last:border-b-0 last:pb-0">
      <ModelName name={model.name} index={index} className="text-body" />
      <span className="flex items-center gap-2">
        {loaded && model.loaded_at && (
          <span className="text-meta text-text-faint" title={fmt.dateTime(model.loaded_at)}>
            {t("today.models.loadedAt", { age: fmt.relative(model.loaded_at) })}
          </span>
        )}
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
      </span>
    </li>
  );
}
