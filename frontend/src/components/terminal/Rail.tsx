"use client";
import { Fragment } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { Glyph } from "./Glyph";
import { useLocale } from "@/contexts/LocaleContext";

// When navigating *between* /picks/* routes, carry over the data-source
// selection so switching tabs preserves the current backtest run(s).
const PICKS_QUERY_KEYS = ["source", "run_id", "run_ids"] as const;

function picksQuerySuffix(
  pathname: string,
  itemHref: string,
  searchParams: URLSearchParams | null,
): string {
  if (!searchParams) return "";
  const fromPicks = pathname.includes("/picks/");
  const toPicks = itemHref.includes("/picks/");
  if (!fromPicks || !toPicks) return "";
  const carried = new URLSearchParams();
  for (const k of PICKS_QUERY_KEYS) {
    const v = searchParams.get(k);
    if (v) carried.set(k, v);
  }
  const qs = carried.toString();
  return qs ? `?${qs}` : "";
}

type Item = {
  href: string;
  label: string;
  matchPrefix?: string;
  indent?: number;
  branch?: boolean;
  /** When true, render a separator <li> above this row */
  separatorAbove?: boolean;
};

function useRailItems(): Item[] {
  const { locale } = useLocale();
  const p = (s: string) => `/${locale}${s}`;
  return [
    { href: p("/today"), label: "Today" },
    { href: p("/odds"), label: "Odds" },
    { href: p("/matches"), label: "Matches", matchPrefix: p("/matches") },
    { href: p("/picks/health"), label: "Picks", matchPrefix: p("/picks") },
    { href: p("/picks/health"), label: "Health", indent: 1, branch: true },
    {
      href: p("/picks/models"),
      label: "Models",
      indent: 1,
      branch: true,
      matchPrefix: p("/picks/models")
    },
    { href: p("/picks/explore"), label: "Explore", indent: 1, branch: true },
    { href: p("/jobs"), label: "Jobs" },
    { href: p("/settings"), label: "Settings", separatorAbove: true }
  ];
}

function RailList({
  items,
  pathname,
  searchParams,
  onNavigate,
  variant
}: {
  items: Item[];
  pathname: string;
  searchParams: URLSearchParams | null;
  onNavigate?: () => void;
  variant: "desktop" | "mobile";
}) {
  return (
    <ul className="flex flex-col gap-[2px]">
      {items.map((it, i) => {
        const active = it.matchPrefix
          ? pathname.startsWith(it.matchPrefix)
          : pathname === it.href;
        const key = `${it.href}-${i}`;
        const suffix = picksQuerySuffix(pathname, it.href, searchParams);
        const itemWithHref = suffix ? { ...it, href: `${it.href}${suffix}` } : it;
        if (it.separatorAbove) {
          return (
            <Fragment key={key}>
              <li className="my-2 border-t border-border" aria-hidden />
              <RailRow item={itemWithHref} active={active} variant={variant} onNavigate={onNavigate} />
            </Fragment>
          );
        }
        return (
          <RailRow
            key={key}
            item={itemWithHref}
            active={active}
            variant={variant}
            onNavigate={onNavigate}
          />
        );
      })}
    </ul>
  );
}

export function Rail({
  open = false,
  onClose
}: { open?: boolean; onClose?: () => void } = {}) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const items = useRailItems();

  return (
    <>
      {/* desktop */}
      <nav
        aria-label="Primary"
        className="fixed left-0 top-8 bottom-6 z-20 hidden w-[180px] flex-col border-r border-border bg-bg px-3 py-4 md:flex"
      >
        <div
          className="mb-3 flex items-center gap-1 text-[10px] uppercase text-text-faint"
          style={{ letterSpacing: "var(--track-wide)" }}
        >
          <Glyph kind="section" /> Navigation
        </div>
        <RailList items={items} pathname={pathname} searchParams={searchParams} variant="desktop" />
      </nav>

      {/* mobile drawer */}
      {open && (
        <nav
          aria-label="Primary (mobile)"
          className="fixed inset-0 z-40 flex flex-col bg-bg px-6 pt-10 md:hidden"
        >
          <button
            onClick={onClose}
            className="absolute right-4 top-3 border-none font-mono text-[10px] text-text-dim"
            aria-label="Close menu"
          >
            esc
          </button>
          <div
            className="mb-3 flex items-center gap-1 text-[10px] uppercase text-text-faint"
            style={{ letterSpacing: "var(--track-wide)" }}
          >
            <Glyph kind="section" /> Navigation
          </div>
          <RailList
            items={items}
            pathname={pathname}
            searchParams={searchParams}
            variant="mobile"
            onNavigate={onClose}
          />
        </nav>
      )}
    </>
  );
}

function RailRow({
  item,
  active,
  variant,
  onNavigate
}: {
  item: Item;
  active: boolean;
  variant: "desktop" | "mobile";
  onNavigate?: () => void;
}) {
  return (
    <li className="relative">
      {active && variant === "desktop" && (
        <span
          className="absolute left-[-12px] top-0 bottom-0 w-[2px] bg-accent"
          aria-hidden
        />
      )}
      <Link
        href={item.href as unknown as Parameters<typeof Link>[0]["href"]}
        onClick={onNavigate}
        className={clsx(
          "flex items-center gap-1 py-[2px] font-sans uppercase",
          variant === "mobile" ? "text-[14px]" : "text-[10px]",
          active ? "text-accent" : "text-text-dim hover:text-text"
        )}
        style={{
          letterSpacing: "var(--track-wide)",
          paddingLeft: item.indent ? `${item.indent * 12}px` : 0
        }}
      >
        {item.branch && <Glyph kind="branch" className="text-text-faint" />}
        {item.label}
      </Link>
    </li>
  );
}
