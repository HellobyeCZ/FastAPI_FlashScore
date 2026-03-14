"use client";

import { useLocale } from "@/contexts/LocaleContext";

export default function ModelsPage() {
  const { t } = useLocale();

  const features = [
    {
      titleKey: "models.feature.trainTitle" as const,
      descKey: "models.feature.train" as const,
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      ),
    },
    {
      titleKey: "models.feature.backtestTitle" as const,
      descKey: "models.feature.backtest" as const,
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
    },
    {
      titleKey: "models.feature.liveTrackTitle" as const,
      descKey: "models.feature.liveTrack" as const,
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-high)]">{t("models.title")}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("models.description")}</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div
            key={f.titleKey}
            className="relative overflow-hidden rounded-2xl border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface-alt)] p-6 shadow-sm"
          >
            <span className="absolute right-4 top-4 rounded-full border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {t("models.comingSoon")}
            </span>
            <div className="mb-4 inline-flex rounded-xl bg-[var(--color-brand-surface)] p-3">
              {f.icon}
            </div>
            <h3 className="text-base font-semibold text-[var(--color-text-high)]">{t(f.titleKey)}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">{t(f.descKey)}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-dashed border-[var(--color-brand-outline)] bg-[var(--color-brand-surface-alt)] p-8 text-center">
        <div className="mx-auto mb-4 inline-flex rounded-full bg-[var(--color-brand-surface)] p-4">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">
          Model training, backtesting, and live tracking will be available here.
          <br />
          Data collection through the Dashboard is the first step.
        </p>
      </div>
    </div>
  );
}
