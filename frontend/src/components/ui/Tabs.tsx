"use client";
import Link from "next/link";
import type { Route } from "next";
import { clsx } from "clsx";

export type TabItem = { href: Route; label: React.ReactNode; active: boolean; hint?: React.ReactNode };

/** Route-based sub-navigation (each tab is a link; current one has aria-current). */
export function LinkTabs({ items, label, className }: { items: TabItem[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={clsx("mb-5 overflow-x-auto border-b border-border", className)}>
      <ul className="flex min-w-max items-stretch gap-1">
        {items.map((it, i) => (
          <li key={i}>
            <Link
              href={it.href}
              aria-current={it.active ? "page" : undefined}
              className={clsx(
                "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-3 font-sans text-label uppercase tracking-label transition-colors",
                it.active
                  ? "border-accent text-text"
                  : "border-transparent text-text-dim hover:border-border-strong hover:text-text"
              )}
            >
              {it.label}
              {it.hint !== undefined && <span className="font-mono text-text-faint">{it.hint}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
