"use client";
import { Fragment, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { isActive, navItems, stripLocale, type NavItem } from "./nav";

function Item({ item, path, depth, onNavigate }: { item: NavItem; path: string; depth: number; onNavigate?: () => void }) {
  const { t } = useLocale();
  const active = isActive(item, path);
  const groupActive = item.children ? isActive(item, path) : false;
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active && !item.children ? "page" : undefined}
        className={clsx(
          "group relative flex h-9 items-center justify-between gap-2 pr-3 font-sans uppercase tracking-label transition-colors",
          depth === 0 ? "pl-4 text-label" : "pl-8 text-label",
          active ? "text-text" : "text-text-dim hover:bg-surface-2 hover:text-text",
          active && depth === 0 && !item.children && "bg-surface-2",
          active && depth > 0 && "bg-surface-2"
        )}
      >
        {active && (depth > 0 || !item.children) && (
          <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 bg-accent" />
        )}
        <span className={clsx(groupActive && item.children && "text-text")}>{t(item.label)}</span>
        {item.combo && depth === 0 && (
          <kbd className="hidden font-mono text-label normal-case tracking-normal text-text-faint group-hover:inline">
            {item.combo}
          </kbd>
        )}
      </Link>
      {item.children && (
        <ul>
          {item.children.map((c) => (
            <Item key={c.id} item={c} path={path} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { locale, t } = useLocale();
  const pathname = usePathname() ?? "/";
  const path = stripLocale(pathname);
  const items = navItems(locale);
  const top = items.filter((i) => !i.bottom);
  const bottom = items.filter((i) => i.bottom);
  return (
    <nav aria-label={t("nav.label")} className="flex h-full flex-col justify-between py-3">
      <ul className="flex flex-col gap-0.5">
        {top.map((it) => (
          <Fragment key={it.id}>
            <Item item={it} path={path} depth={0} onNavigate={onNavigate} />
          </Fragment>
        ))}
      </ul>
      <ul className="flex flex-col gap-0.5 border-t border-border pt-3">
        {bottom.map((it) => (
          <Item key={it.id} item={it} path={path} depth={0} onNavigate={onNavigate} />
        ))}
      </ul>
    </nav>
  );
}

/** Desktop: fixed left rail. Mobile: modal drawer (focus moves in, Escape closes). */
export function Rail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const { t } = useLocale();

  useEffect(() => {
    onClose();
    // close the drawer whenever the route changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    drawerRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <aside className="fixed bottom-shell-bottom left-0 top-shell-top z-20 hidden w-rail border-r border-border bg-bg md:block">
        <NavList />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div aria-hidden className="absolute inset-0 bg-bg/80" onClick={onClose} />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.label")}
            className="absolute bottom-0 left-0 top-shell-top w-72 max-w-[85vw] border-r border-border-strong bg-bg"
          >
            <NavList onNavigate={onClose} />
          </div>
        </div>
      )}
    </>
  );
}
