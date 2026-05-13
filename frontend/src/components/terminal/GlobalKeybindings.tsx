"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useKeybindings, type Keybinding } from "@/hooks/useKeybindings";
import { useLocale } from "@/contexts/LocaleContext";
import { KeyboardSheet } from "./KeyboardSheet";

export function GlobalKeybindings() {
  const router = useRouter();
  const { locale } = useLocale();
  const [sheet, setSheet] = useState(false);

  const bindings = useMemo<Keybinding[]>(() => {
    const p = (s: string) =>
      `/${locale}${s}` as unknown as Parameters<typeof router.push>[0];
    return [
      { combo: "g t", description: "Go: Today", handler: () => router.push(p("/today")) },
      { combo: "g o", description: "Go: Odds", handler: () => router.push(p("/odds")) },
      { combo: "g m", description: "Go: Matches", handler: () => router.push(p("/matches")) },
      { combo: "g p", description: "Go: Picks", handler: () => router.push(p("/picks/health")) },
      { combo: "g j", description: "Go: Jobs", handler: () => router.push(p("/jobs")) },
      { combo: "g s", description: "Go: Settings", handler: () => router.push(p("/settings")) },
      {
        combo: "/",
        description: "Focus search",
        handler: () => {
          const el = document.querySelector<HTMLInputElement>("[data-search-input]");
          el?.focus();
        }
      },
      { combo: "?", description: "Show keyboard", handler: () => setSheet(true) },
      { combo: "Escape", description: "Close overlay", handler: () => setSheet(false) }
    ];
  }, [locale, router]);

  useKeybindings(bindings);

  return <KeyboardSheet open={sheet} onClose={() => setSheet(false)} />;
}
