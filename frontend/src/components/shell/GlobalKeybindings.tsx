"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useKeybindings, useAllKeybindings, type Keybinding } from "@/hooks/useKeybindings";
import { useLocale } from "@/contexts/LocaleContext";
import { Dialog } from "@/components/ui";
import { navItems } from "./nav";

export function GlobalKeybindings() {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [sheet, setSheet] = useState(false);

  const bindings = useMemo<Keybinding[]>(() => {
    const nav = navItems(locale)
      .filter((i) => i.combo && i.comboLabel)
      .map<Keybinding>((i) => ({
        combo: i.combo!,
        description: t(i.comboLabel!),
        handler: () => router.push(i.href)
      }));
    return [
      ...nav,
      {
        combo: "/",
        description: t("kbd.search"),
        handler: () => document.querySelector<HTMLInputElement>("[data-search-input]")?.focus()
      },
      { combo: "?", description: t("kbd.help"), handler: () => setSheet(true) }
    ];
  }, [locale, router, t]);

  useKeybindings(bindings);

  return <KeyboardSheet open={sheet} onClose={() => setSheet(false)} />;
}

function KeyboardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const bindings = useAllKeybindings();
  return (
    <Dialog open={open} onClose={onClose} title={t("kbd.title")} description={t("kbd.hint")} size="lg">
      <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {bindings.map((b) => (
          <li key={b.combo} className="flex items-center justify-between gap-4 border-b border-border py-1.5">
            <span className="text-body text-text-dim">{b.description}</span>
            <span className="flex gap-1">
              {b.combo.split(" ").map((k, i) => (
                <kbd key={i} className="min-w-[1.5rem] border border-border-strong px-1.5 text-center font-mono text-meta text-text">
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
