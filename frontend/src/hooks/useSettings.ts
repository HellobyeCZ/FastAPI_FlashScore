"use client";
import { useSyncExternalStore } from "react";

export type Settings = {
  scanlines: boolean;
  /** Compact table density (smaller row padding). */
  dense: boolean;
  /** Default minimum edge filter on the Today slate (fraction, 0 = all). */
  minEdge: number;
};

const KEY = "terminal.settings.v2";
const DEFAULTS: Settings = { scanlines: false, dense: false, minEdge: 0 };

// A tiny shared store so every component sees the same settings and changes
// apply immediately (the old hook kept a private copy per caller).
let current: Settings = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // private mode / blocked storage: keep defaults
  }
}

function subscribe(cb: () => void) {
  load();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    () => {
      load();
      return current;
    },
    () => DEFAULTS
  );

  function update(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // ignore
    }
    listeners.forEach((l) => l());
  }

  return { settings, update };
}
