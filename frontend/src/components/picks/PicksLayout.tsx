"use client";

import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { useLocale } from "@/contexts/LocaleContext";
import type { MessageKey } from "@/lib/i18n";
import type { ReactNode } from "react";

export type PicksTab = "health" | "models" | "explore";

const TABS: PicksTab[] = ["health", "models", "explore"];

export function PicksLayout({ activeTab, children }: { activeTab: PicksTab; children: ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function tabHref(tab: PicksTab): string {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("tab", tab);
    return `${pathname}?${qs.toString()}`;
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--color-text-high)]">{t("picks.title")}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-text-muted)]">{t("picks.description")}</p>
        </div>
        <LocaleSwitcher />
      </header>

      <nav className="flex gap-1 rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface-alt)] p-1">
        {TABS.map((tab) => (
          <Link
            // Next.js 14 typedRoutes can't statically validate
            // dynamic ?<qs> paths, hence the cast on href below.
            key={tab}
            href={tabHref(tab) as unknown as Parameters<typeof Link>[0]["href"]}
            className={
              tab === activeTab
                ? "rounded-xl bg-[color:var(--color-brand-primary)] px-4 py-2 text-sm font-semibold text-[color:var(--color-text-inverse)]"
                : "rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--color-text-muted)] hover:bg-[color:var(--color-brand-surface)]"
            }
          >
            {t(`picks.tabs.${tab}` as MessageKey)}
          </Link>
        ))}
      </nav>

      {children}
    </main>
  );
}
