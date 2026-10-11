"use client";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { useLocale } from "@/contexts/LocaleContext";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { HealthIndicator } from "./health";

const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

export function StatusBar() {
  const { locale, t, fmt } = useLocale();
  const ops = useOpsStatus();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const clock = now
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(now)
    : "--:--";
  const mlflow = ops.data?.mlflow;

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-30 flex h-shell-bottom items-center justify-between gap-4 border-t border-border bg-bg px-3 font-mono text-meta text-text-dim sm:px-4">
      <HealthIndicator />
      <div className="flex items-center gap-4">
        {mlflow && (
          <span className="hidden items-center gap-1.5 sm:inline-flex" title={mlflow.tracking_uri ?? undefined}>
            {t("common.mlflow")}
            <span className={clsx(mlflow.enabled && mlflow.reachable ? "text-pos" : "text-warn")}>
              {mlflow.enabled ? (mlflow.reachable ? "●" : "○") : "–"}
            </span>
          </span>
        )}
        {ops.data?.db.size_bytes != null && (
          <span className="hidden md:inline">{t("health.db", { size: fmt.bytes(ops.data.db.size_bytes) })}</span>
        )}
        <span className="hidden lg:inline" suppressHydrationWarning>
          {t("health.build", { sha: BUILD_SHA })}
        </span>
        <time suppressHydrationWarning>{clock}</time>
      </div>
    </footer>
  );
}
