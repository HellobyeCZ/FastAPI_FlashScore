"use client";

import { useEffect, useRef, useState } from "react";
import {
  createBacktestRun,
  listBacktestModels,
  type CreateBacktestRequest,
} from "@/lib/api-backtest";

export function BacktestAdvancedDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [form, setForm] = useState<CreateBacktestRequest>({
    model: "market_implied",
    train_until: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
    min_edge: 0.02,
    kelly_fraction: 0.25,
    force_bets: false,
  });

  useEffect(() => {
    if (open) {
      ref.current?.showModal();
      listBacktestModels()
        .then(setModels)
        .catch(() => setModels(["market_implied"]));
    } else {
      ref.current?.close();
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...form, train_until: new Date(form.train_until).toISOString() };
      const { id } = await createBacktestRun(body);
      onCreated(id);
      onClose();
    } catch (err) {
      console.error(err);
      alert("Failed to create backtest run");
    }
  };

  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClose={onClose}
      className="p-4 bg-zinc-900 text-zinc-100 border border-zinc-700"
    >
      <form onSubmit={submit} className="flex flex-col gap-3 text-xs min-w-[24rem]">
        <label className="flex flex-col gap-1">
          model
          <select
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="bg-zinc-800 p-1"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          train_until (UTC date)
          <input
            type="date"
            value={form.train_until.slice(0, 10)}
            onChange={(e) => setForm({ ...form, train_until: e.target.value })}
            className="bg-zinc-800 p-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          min_edge: {form.min_edge}
          <input
            type="range"
            min={0}
            max={0.1}
            step={0.005}
            value={form.min_edge}
            onChange={(e) =>
              setForm({ ...form, min_edge: Number(e.target.value) })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          kelly_fraction: {form.kelly_fraction}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={form.kelly_fraction}
            onChange={(e) =>
              setForm({ ...form, kelly_fraction: Number(e.target.value) })
            }
          />
        </label>
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={form.force_bets ?? false}
            onChange={(e) => setForm({ ...form, force_bets: e.target.checked })}
          />
          force bets (disable edge gate)
        </label>
        <label className="flex flex-col gap-1">
          label (optional)
          <input
            value={form.label ?? ""}
            onChange={(e) =>
              setForm({ ...form, label: e.target.value || null })
            }
            className="bg-zinc-800 p-1"
          />
        </label>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="underline">
            cancel
          </button>
          <button type="submit" className="underline font-semibold">
            queue run
          </button>
        </div>
      </form>
    </dialog>
  );
}
