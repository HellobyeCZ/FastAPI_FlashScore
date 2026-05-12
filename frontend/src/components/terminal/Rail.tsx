"use client";
import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { Glyph } from "./Glyph";
import { useLocale } from "@/contexts/LocaleContext";

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

function RailList({ items, pathname }: { items: Item[]; pathname: string }) {
  return (
    <ul className="flex flex-col gap-[2px]">
      {items.map((it, i) => {
        const active = it.matchPrefix
          ? pathname.startsWith(it.matchPrefix)
          : pathname === it.href;
        const key = `${it.href}-${i}`;
        if (it.separatorAbove) {
          return (
            <Fragment key={key}>
              <li className="my-2 border-t border-border" aria-hidden />
              <RailRow item={it} active={active} />
            </Fragment>
          );
        }
        return <RailRow key={key} item={it} active={active} />;
      })}
    </ul>
  );
}

export function Rail() {
  const pathname = usePathname() ?? "/";
  const items = useRailItems();

  return (
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
      <RailList items={items} pathname={pathname} />
    </nav>
  );
}

function RailRow({ item, active }: { item: Item; active: boolean }) {
  return (
    <li className="relative">
      {active && (
        <span
          className="absolute left-[-12px] top-0 bottom-0 w-[2px] bg-accent"
          aria-hidden
        />
      )}
      <Link
        href={item.href as unknown as Parameters<typeof Link>[0]["href"]}
        className={clsx(
          "flex items-center gap-1 py-[2px] font-sans text-[10px] uppercase",
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
