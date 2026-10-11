"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { LinkTabs } from "@/components/ui";
import { routes } from "@/lib/routes";

export type LabSection = "backtests" | "experiments" | "registry";

/** Model lab sub-navigation (also reachable from the rail on desktop). */
export function LabTabs({ active }: { active: LabSection }) {
  const { t, locale } = useLocale();
  return (
    <LinkTabs
      label={t("lab.tabs.label")}
      items={[
        { href: routes.backtests(locale), label: t("nav.lab.backtests"), active: active === "backtests" },
        { href: routes.experiments(locale), label: t("nav.lab.experiments"), active: active === "experiments" },
        { href: routes.registry(locale), label: t("nav.lab.registry"), active: active === "registry" }
      ]}
    />
  );
}
