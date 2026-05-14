"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export type SourceValue = "live" | "backtest" | "both";

export function DataSourcePicker() {
  const router = useRouter();
  const sp = useSearchParams();
  const current = (sp.get("source") as SourceValue | null) ?? "live";

  const set = useCallback(
    (v: SourceValue) => {
      const params = new URLSearchParams(sp.toString());
      params.set("source", v);
      if (v === "live") params.delete("run_id");
      router.replace(`?${params.toString()}`);
    },
    [router, sp],
  );

  return (
    <div className="flex gap-2 items-center text-xs">
      <span className="text-zinc-500">Data:</span>
      {(["live", "backtest", "both"] as SourceValue[]).map((v) => (
        <button
          key={v}
          onClick={() => set(v)}
          className={
            current === v
              ? "underline font-semibold"
              : "text-zinc-400 hover:text-zinc-200"
          }
          type="button"
        >
          {v}
        </button>
      ))}
    </div>
  );
}
