"use client";
import { useEffect, useState } from "react";

export type Settings = {
  scanlines: boolean;
  refreshInterval: number; // ms, 0 = off
};

const KEY = "terminal.settings.v1";
const DEFAULTS: Settings = { scanlines: false, refreshInterval: 0 };

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);

  function update(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  return { settings, update };
}
