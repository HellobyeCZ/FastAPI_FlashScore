"use client";
import { useEffect } from "react";
import { useAllKeybindings } from "@/hooks/useKeybindings";
import { KeyHint } from "./KeyHint";

export function KeyboardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bindings = useAllKeybindings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/90 pt-20">
      <div className="w-full max-w-3xl border border-border bg-bg p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <h2
            className="font-sans text-[11px] uppercase text-accent"
            style={{ letterSpacing: "var(--track-wide)" }}
          >
            ▌ Keyboard
          </h2>
          <span className="font-mono text-[10px] text-text-dim">esc to close</span>
        </div>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[12px]">
          {bindings.map((b) => (
            <li
              key={b.combo}
              className="flex items-center justify-between border-b border-border py-1"
            >
              <span className="text-text-dim">{b.description}</span>
              <KeyHint keys={b.combo.split(" ")} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
