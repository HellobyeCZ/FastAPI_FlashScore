"use client";
import Link from "next/link";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { routes } from "@/lib/routes";
import { Callout, ButtonLink } from "@/components/ui";
import type { HealthIssue, HealthLevel } from "@/types/ops";
import type { MessageKey } from "@/lib/i18n";

export type ShellHealth = {
  level: HealthLevel | "unknown";
  issues: { code: string; level: "warn" | "error"; text: string }[];
};

const KNOWN = new Set([
  "pipeline_stale",
  "pipeline_never",
  "settle_overdue",
  "no_models_loaded",
  "live_odds_stale",
  "mlflow_unreachable",
  "mlflow_disabled"
]);

/**
 * Localized health derived from GET /ops/status. A failed status call is
 * itself an error-level issue ("backend unreachable") — the old status LED
 * showed green whenever a COUNT(*) query happened to succeed.
 */
export function useShellHealth(): ShellHealth & { isLoading: boolean } {
  const { t, fmt } = useLocale();
  const q = useOpsStatus();
  if (q.isLoading) return { level: "unknown", issues: [], isLoading: true };
  if (q.isError || !q.data) {
    return {
      level: "error",
      issues: [{ code: "backend_unreachable", level: "error", text: t("health.issue.backend_unreachable") }],
      isLoading: false
    };
  }
  const issues = q.data.health.issues.map((i: HealthIssue) => {
    const since = typeof i.params?.since === "string" ? i.params.since : null;
    const values = { ...i.params, age: since ? fmt.relative(since) : "", message: i.message } as Record<
      string,
      string | number
    >;
    const key = (KNOWN.has(i.code) ? `health.issue.${i.code}` : "health.issue.unknown") as MessageKey;
    return { code: i.code, level: i.level, text: t(key, values) };
  });
  return { level: q.data.health.level, issues, isLoading: false };
}

export function HealthDot({ level, className }: { level: ShellHealth["level"]; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-block h-2 w-2",
        level === "ok" && "bg-pos",
        level === "warn" && "bg-warn",
        level === "error" && "bg-neg",
        level === "unknown" && "bg-text-faint",
        className
      )}
      style={{ borderRadius: "50%" }}
    />
  );
}

/** Compact status: dot + word, links to Data ops. Used in TopBar/StatusBar. */
export function HealthIndicator({ className }: { className?: string }) {
  const { t, locale } = useLocale();
  const h = useShellHealth();
  const label =
    h.level === "ok"
      ? t("health.ok")
      : h.level === "warn"
        ? t("health.warn")
        : h.level === "error"
          ? t("health.error")
          : t("health.checking");
  return (
    <Link
      href={routes.ops(locale)}
      className={clsx("inline-flex items-center gap-1.5 hover:text-text", className)}
      title={h.issues.map((i) => i.text).join("\n") || label}
    >
      <HealthDot level={h.level} />
      <span>{label}</span>
      {h.issues.length > 0 && <span className="text-text-faint">({h.issues.length})</span>}
    </Link>
  );
}

/**
 * Banner listing current health issues. `variant="slim"` is the one-liner the
 * shell shows on every page; `full` lists every issue (Today, Data ops).
 */
export function HealthBanner({ variant = "full", className }: { variant?: "slim" | "full"; className?: string }) {
  const { t, locale } = useLocale();
  const h = useShellHealth();
  if (h.level === "ok" || h.level === "unknown" || h.issues.length === 0) return null;
  const tone = h.level === "error" ? "neg" : "warn";
  if (variant === "slim") {
    const first = h.issues[0];
    return (
      <div
        role="status"
        className={clsx(
          "flex flex-wrap items-center justify-between gap-2 border-b px-4 py-1.5 text-meta sm:px-6",
          tone === "neg" ? "border-neg/40 bg-neg/5 text-neg" : "border-warn/40 bg-warn/5 text-warn",
          className
        )}
      >
        <span className="min-w-0">
          <span aria-hidden>{tone === "neg" ? "✕ " : "△ "}</span>
          {first.text}
          {h.issues.length > 1 && <span className="text-text-dim"> +{h.issues.length - 1}</span>}
        </span>
        <Link href={routes.ops(locale)} className="underline underline-offset-2 hover:text-text">
          {t("health.action.ops")}
        </Link>
      </div>
    );
  }
  return (
    <Callout
      tone={tone}
      className={className}
      title={t("health.details")}
      action={
        <ButtonLink href={routes.ops(locale)} size="sm">
          {t("health.action.ops")}
        </ButtonLink>
      }
    >
      <ul className="flex flex-col gap-1">
        {h.issues.map((i) => (
          <li key={i.code} className={i.level === "error" ? "text-neg" : "text-text-dim"}>
            {i.text}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
