"use client";
import { useEffect, useState } from "react";
import { Glyph } from "./Glyph";
import { useDbStats } from "@/hooks/useDbStats";
import { useLocale } from "@/contexts/LocaleContext";

const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

export function StatusBar({ pageHints }: { pageHints?: string }) {
  const { locale } = useLocale();
  const stats = useDbStats();
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const ledColor =
    stats.status === "success"
      ? "text-accent"
      : stats.status === "error"
        ? "text-neg"
        : "text-text-faint";
  const ledLabel =
    stats.status === "success" ? "ok" : stats.status === "error" ? "err" : "—";

  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);

  const rows =
    stats.data && "rows" in stats.data ? stats.data.rows.toLocaleString(locale) : "—";

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-30 flex h-6 items-center justify-between border-t border-border bg-bg px-4 font-mono text-[10px] text-text-dim">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <span className="text-text-faint">[</span>
          <Glyph kind="led" className={ledColor} />
          <span>{ledLabel}</span>
          <span className="text-text-faint">]</span>
        </span>
        {pageHints && <span className="hidden md:inline">KEY: {pageHints}</span>}
      </div>
      <div className="flex items-center gap-4">
        <span>{clock}</span>
        <span className="hidden sm:inline">db: {rows} rows</span>
        <span className="hidden sm:inline">build: {BUILD_SHA}</span>
      </div>
    </footer>
  );
}
