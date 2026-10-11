import type { Route } from "next";
import type { Locale, MessageKey } from "@/lib/i18n";
import { routes } from "@/lib/routes";

export type NavItem = {
  id: string;
  label: MessageKey;
  href: Route;
  /** Path prefixes (after /{locale}) that mark this item active. */
  match: string[];
  /** Keyboard sequence, e.g. "g t". */
  combo?: string;
  comboLabel?: MessageKey;
  children?: NavItem[];
  bottom?: boolean;
};

export function navItems(l: Locale): NavItem[] {
  return [
    { id: "today", label: "nav.today", href: routes.today(l), match: ["/today"], combo: "g t", comboLabel: "kbd.goToday" },
    { id: "matches", label: "nav.matches", href: routes.matches(l), match: ["/matches"], combo: "g m", comboLabel: "kbd.goMatches" },
    {
      id: "performance",
      label: "nav.performance",
      href: routes.performance(l),
      match: ["/performance", "/models/"],
      combo: "g p",
      comboLabel: "kbd.goPerformance",
      children: [
        { id: "performance.overview", label: "nav.performance.overview", href: routes.performance(l), match: ["/performance"] },
        { id: "performance.explore", label: "nav.performance.explore", href: routes.explore(l), match: ["/performance/explore"] }
      ]
    },
    {
      id: "lab",
      label: "nav.lab",
      href: routes.backtests(l),
      match: ["/lab"],
      combo: "g l",
      comboLabel: "kbd.goLab",
      children: [
        { id: "lab.backtests", label: "nav.lab.backtests", href: routes.backtests(l), match: ["/lab/backtests", "/lab/compare"] },
        { id: "lab.experiments", label: "nav.lab.experiments", href: routes.experiments(l), match: ["/lab/experiments"] },
        { id: "lab.registry", label: "nav.lab.registry", href: routes.registry(l), match: ["/lab/registry"] }
      ]
    },
    { id: "ops", label: "nav.ops", href: routes.ops(l), match: ["/ops"], combo: "g o", comboLabel: "kbd.goOps" },
    { id: "settings", label: "nav.settings", href: routes.settings(l), match: ["/settings"], combo: "g s", comboLabel: "kbd.goSettings", bottom: true }
  ];
}

/** Path without the /{locale} prefix. */
export function stripLocale(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(?=\/|$)/, "") || "/";
}

export function isActive(item: NavItem, path: string): boolean {
  // Exact-ish matching for children so "/performance" doesn't light up on "/performance/explore".
  if (item.id === "performance.overview") return path === "/performance" || path.startsWith("/models/");
  return item.match.some((m) => path === m || path.startsWith(m.endsWith("/") ? m : `${m}/`) || path === m);
}
