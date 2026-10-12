"use client";
import Link from "next/link";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { locales } from "@/lib/i18n";
import { routes } from "@/lib/routes";
import { HealthIndicator } from "./health";

export function TopBar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  const { locale, setLocale, t } = useLocale();
  return (
    <header className="fixed left-0 right-0 top-0 z-30 flex h-shell-top items-center justify-between gap-3 border-b border-border bg-bg px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenu}
          aria-label={t("nav.menu")}
          aria-expanded={menuOpen}
          className="inline-flex h-8 w-8 items-center justify-center border border-border-strong text-text-dim hover:text-text md:hidden"
        >
          ≡
        </button>
        <Link href={routes.today(locale)} className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="text-accent">
            ▌
          </span>
          <span className="truncate font-sans text-label uppercase tracking-label text-text">{t("app.name")}</span>
        </Link>
      </div>
      <div className="flex items-center gap-3 sm:gap-4">
        <HealthIndicator className="hidden text-meta text-text-dim sm:inline-flex" />
        <div role="group" aria-label={t("nav.language")} className="flex items-center border border-border-strong">
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={l === locale}
              onClick={() => setLocale(l)}
              className={clsx(
                "h-7 px-2 font-mono text-label uppercase",
                l === locale ? "bg-accent text-accent-ink" : "text-text-dim hover:text-text"
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
