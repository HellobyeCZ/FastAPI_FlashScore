"use client";
import { clsx } from "clsx";
import { Glyph } from "./Glyph";
import { useLocale } from "@/contexts/LocaleContext";
import { useDbStats } from "@/hooks/useDbStats";

export function TopBar({
  onMenu,
  menuOpen
}: { onMenu?: () => void; menuOpen?: boolean } = {}) {
  const { locale, setLocale } = useLocale();
  const stats = useDbStats();
  const ledColor =
    stats.status === "success"
      ? "text-accent"
      : stats.status === "error"
        ? "text-neg"
        : "text-text-faint";

  return (
    <header className="fixed top-0 left-0 right-0 z-30 flex h-8 items-center justify-between border-b border-border bg-bg px-4 font-sans">
      <div className="flex items-center gap-2">
        <button
          onClick={onMenu}
          className="border-none px-2 text-text-dim md:hidden"
          aria-label="Toggle menu"
          aria-expanded={menuOpen ?? false}
        >
          ≡
        </button>
        <Glyph kind="section" className="text-accent" />
        <span
          className="text-[11px] uppercase text-text"
          style={{ letterSpacing: "var(--track-wide)" }}
        >
          Flashscore/Terminal
        </span>
        <span className="text-[10px] text-text-faint">· v0.1</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 font-mono text-[10px]">
          <button
            onClick={() => setLocale("en")}
            className={clsx(
              "border-none px-1 py-0",
              locale === "en" ? "text-accent" : "text-text-dim"
            )}
          >
            EN
          </button>
          <span className="text-text-faint">|</span>
          <button
            onClick={() => setLocale("cs")}
            className={clsx(
              "border-none px-1 py-0",
              locale === "cs" ? "text-accent" : "text-text-dim"
            )}
          >
            CS
          </button>
        </div>
        <Glyph kind="led" className={ledColor} />
      </div>
    </header>
  );
}
