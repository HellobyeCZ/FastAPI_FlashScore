"use client";
import { useCallback, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { useSettings } from "@/hooks/useSettings";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { StatusBar } from "./StatusBar";
import { GlobalKeybindings } from "./GlobalKeybindings";
import { HealthBanner } from "./health";

export function Shell({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const { settings } = useSettings();
  const { t } = useLocale();
  return (
    <>
      <a
        href="#main"
        className="sr-only-focusable fixed left-2 top-2 z-[60] bg-accent px-3 py-2 font-mono text-meta text-accent-ink"
      >
        {t("nav.skip")}
      </a>
      <TopBar onMenu={() => setMenu((v) => !v)} menuOpen={menu} />
      <Rail open={menu} onClose={closeMenu} />
      <main id="main" tabIndex={-1} className="pb-shell-bottom pt-shell-top focus:outline-none md:pl-rail">
        <HealthBanner variant="slim" />
        <div className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
      <StatusBar />
      <GlobalKeybindings />
      {settings.scanlines && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[70]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgb(0 0 0 / 0.18) 0, rgb(0 0 0 / 0.18) 1px, transparent 1px, transparent 3px)"
          }}
        />
      )}
    </>
  );
}
