"use client";

import { useState } from "react";
import { createBacktestRun } from "@/lib/api-backtest";

const DEFAULT_TRAIN_UNTIL = () => {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString();
};

export function RunBacktestButton({
  onCreated,
  onAdvanced,
}: {
  onCreated: (id: string) => void;
  onAdvanced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex gap-2 items-center">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const { id } = await createBacktestRun({
              model: "market_implied",
              train_until: DEFAULT_TRAIN_UNTIL(),
            });
            onCreated(id);
          } catch (e) {
            console.error(e);
            alert("Failed to create backtest run");
          } finally {
            setBusy(false);
          }
        }}
        className="text-xs underline disabled:opacity-50"
      >
        {busy ? "queueing…" : "Run backtest"}
      </button>
      <button
        type="button"
        onClick={onAdvanced}
        className="text-xs text-zinc-400 underline"
      >
        advanced…
      </button>
    </div>
  );
}
