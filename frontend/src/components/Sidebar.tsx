"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { useTheme, type Theme } from "@/contexts/ThemeContext";
import { locales, type MessageKey } from "@/lib/i18n";

const NAV_ITEMS: { href: "/" | "/models"; labelKey: MessageKey; icon: React.ReactNode }[] = [
  {
    href: "/",
    labelKey: "nav.dashboard" as MessageKey,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    href: "/models",
    labelKey: "nav.models" as MessageKey,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
];

const THEME_OPTIONS: { value: Theme; labelKey: MessageKey }[] = [
  { value: "system", labelKey: "theme.system" },
  { value: "light", labelKey: "theme.light" },
  { value: "dark", labelKey: "theme.dark" },
];

function ThemeIcon({ resolvedTheme }: { resolvedTheme: "light" | "dark" }) {
  if (resolvedTheme === "dark") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

export function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useLocale();
  const { theme, resolvedTheme, setTheme } = useTheme();

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-[var(--sidebar-width)] flex-col border-r transition-transform duration-200 md:static md:translate-x-0",
          "bg-[var(--sidebar-bg)] border-[var(--sidebar-border)]",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-[var(--sidebar-border)] px-5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <span className="text-base font-bold text-[var(--color-text-high)]">FlashScore</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={clsx(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                  isActive
                    ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--color-text-high)]"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                {item.icon}
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-[var(--sidebar-border)] px-4 py-4">
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              <ThemeIcon resolvedTheme={resolvedTheme} />
              {t("theme.label")}
            </label>
            <div className="flex rounded-lg border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface)] p-0.5">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTheme(opt.value)}
                  className={clsx(
                    "flex-1 rounded-md px-2 py-1 text-xs font-medium transition",
                    theme === opt.value
                      ? "bg-[var(--color-brand-primary)] text-[var(--color-text-inverse)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-high)]"
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              {t("locale.switcher")}
            </label>
            <select
              className="w-full rounded-lg border border-[var(--color-brand-outline)] bg-[var(--color-brand-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-high)] outline-none transition focus:border-[var(--color-brand-primary)]"
              value={locale}
              onChange={(e) => setLocale(e.target.value as typeof locale)}
            >
              {locales.map((v) => (
                <option key={v} value={v}>
                  {t(`locale.${v}` as MessageKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>
    </>
  );
}
