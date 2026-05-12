"use client";
import { useEffect } from "react";

export function Sheet({
  open,
  onClose,
  title,
  children
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-bg/85 pt-16">
      <div className="w-full max-w-4xl border border-border bg-bg p-6">
        <div className="mb-4 flex items-baseline justify-between border-b border-border pb-2">
          <h2
            className="font-sans text-[11px] uppercase text-accent"
            style={{ letterSpacing: "var(--track-wide)" }}
          >▌ {title}</h2>
          <button onClick={onClose} className="border-none text-text-dim">esc</button>
        </div>
        {children}
      </div>
    </div>
  );
}
