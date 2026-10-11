"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { useSettings } from "@/hooks/useSettings";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { routes } from "@/lib/routes";
import { locales, type Locale } from "@/lib/i18n";
import {
  Button,
  ButtonLink,
  Callout,
  Checkbox,
  KeyValue,
  Label,
  PageHeader,
  Panel,
  SegmentedControl,
  Skeleton
} from "@/components/ui";
import { HealthDot, useShellHealth } from "@/components/shell/health";

const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

/** Edge thresholds offered for the Today slate (fractions). */
const MIN_EDGES = ["0", "0.01", "0.03", "0.05"] as const;
type MinEdge = (typeof MIN_EDGES)[number];

/** Snap a stored value to an offered option so exactly one segment is selectable. */
function nearestEdge(v: number): MinEdge {
  return MIN_EDGES.reduce((best, o) => (Math.abs(Number(o) - v) < Math.abs(Number(best) - v) ? o : best));
}

const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", cs: "Čeština" };

/** Visible label (and optional hint) for a control that only carries an aria-label. */
function LabelledControl({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Label as="div">{label}</Label>
      {children}
      {hint && <p className="text-meta text-text-faint">{hint}</p>}
    </div>
  );
}

function AboutPanel() {
  const { t, fmt, locale } = useLocale();
  const status = useOpsStatus();
  const health = useShellHealth();
  const s = status.data;
  const healthLabel =
    health.level === "ok"
      ? t("health.ok")
      : health.level === "warn"
        ? t("health.warn")
        : health.level === "error"
          ? t("health.error")
          : t("health.checking");

  return (
    <Panel
      title={t("settings.about.title")}
      description={t("settings.about.description")}
      footer={
        <ButtonLink href={routes.ops(locale)} size="sm">
          {t("settings.about.ops")}
        </ButtonLink>
      }
    >
      <div className="flex flex-col gap-3">
        <KeyValue
          items={[
            { label: t("settings.about.frontend"), value: BUILD_SHA },
            {
              label: t("settings.about.status"),
              value: (
                <span className="inline-flex items-center gap-1.5" data-health={health.level}>
                  <HealthDot level={health.level} />
                  {healthLabel}
                  {health.issues.length > 0 && <span className="text-text-faint">({health.issues.length})</span>}
                </span>
              )
            },
            {
              label: t("settings.about.backend"),
              value: status.isLoading ? <Skeleton className="ml-auto h-3 w-16" /> : (s?.git_sha ?? "—")
            },
            {
              label: t("settings.about.db"),
              value: status.isLoading ? <Skeleton className="ml-auto h-3 w-16" /> : fmt.bytes(s?.db.size_bytes)
            },
            {
              label: t("settings.about.checked"),
              value: s ? (
                <time dateTime={s.generated_at} title={fmt.dateTime(s.generated_at)}>
                  {fmt.relative(s.generated_at)}
                </time>
              ) : status.isLoading ? (
                <Skeleton className="ml-auto h-3 w-16" />
              ) : (
                "—"
              )
            }
          ]}
        />
        {status.isError && (
          <Callout
            tone="neg"
            title={t("settings.about.error")}
            action={
              <Button size="sm" onClick={() => status.refetch()} loading={status.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {t("settings.about.errorHint")}
          </Callout>
        )}
      </div>
    </Panel>
  );
}

/**
 * Per-browser preferences. Every control writes to the shared settings store
 * (or, for language, navigates), so changes apply immediately everywhere.
 */
export function SettingsPage() {
  const { t, fmt, locale, setLocale } = useLocale();
  const { settings, update } = useSettings();

  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      <div className="grid max-w-5xl items-start gap-6 lg:grid-cols-2">
        <Panel title={t("settings.language.title")} description={t("settings.language.description")}>
          <LabelledControl label={t("settings.language.label")}>
            <SegmentedControl<Locale>
              label={t("settings.language.label")}
              value={locale}
              onChange={setLocale}
              options={locales.map((l) => ({ value: l, label: <span lang={l}>{LANGUAGE_NAMES[l]}</span> }))}
            />
          </LabelledControl>
        </Panel>

        <Panel title={t("settings.display.title")} description={t("settings.display.description")}>
          <div className="flex flex-col gap-4">
            <Checkbox
              label={t("settings.dense")}
              hint={t("settings.dense.hint")}
              checked={settings.dense}
              onChange={(dense) => update({ dense })}
            />
            <Checkbox
              label={t("settings.scanlines")}
              hint={t("settings.scanlines.hint")}
              checked={settings.scanlines}
              onChange={(scanlines) => update({ scanlines })}
            />
          </div>
        </Panel>

        <Panel title={t("settings.today.title")} description={t("settings.today.description")}>
          <LabelledControl label={t("settings.minEdge.label")} hint={t("settings.minEdge.hint")}>
            <SegmentedControl<MinEdge>
              label={t("settings.minEdge.label")}
              value={nearestEdge(settings.minEdge)}
              onChange={(v) => update({ minEdge: Number(v) })}
              options={MIN_EDGES.map((v) => ({
                value: v,
                label: v === "0" ? t("settings.minEdge.all") : fmt.pct(Number(v), 0)
              }))}
            />
          </LabelledControl>
        </Panel>

        <AboutPanel />
      </div>
    </>
  );
}
