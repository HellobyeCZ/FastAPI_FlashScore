"use client";
import { useState } from "react";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { StatusBar } from "./StatusBar";
import { GlobalKeybindings } from "./GlobalKeybindings";
import { useSettings } from "@/hooks/useSettings";

export function Shell({
  children,
  pageHints
}: {
  children: React.ReactNode;
  pageHints?: string;
}) {
  const [menu, setMenu] = useState(false);
  const { settings } = useSettings();
  return (
    <>
      <TopBar onMenu={() => setMenu((v) => !v)} menuOpen={menu} />
      <Rail open={menu} onClose={() => setMenu(false)} />
      <main className="pt-8 pb-6 md:pl-[180px]">
        <GlobalKeybindings />
        <div className="px-6 py-5">{children}</div>
      </main>
      <StatusBar pageHints={pageHints} />
      {settings.scanlines && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)"
          }}
        />
      )}
    </>
  );
}
