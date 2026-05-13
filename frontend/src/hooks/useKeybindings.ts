"use client";
import { useEffect, useRef, useState } from "react";

export type Keybinding = {
  /** Either a single key ("/", "?", "Escape") or a sequence ("g t") */
  combo: string;
  description: string;
  handler: (e: KeyboardEvent) => void;
  /** Page-scoped maps merge into the global map; identical combos in a later registration override earlier ones. */
  scope?: string;
};

const registry = new Map<string, Keybinding>();
const listeners = new Set<() => void>();
let bufferedPrefix: string | null = null;
let bufferedAt = 0;

function notify() {
  listeners.forEach((l) => l());
}

function comboMatches(combo: string, e: KeyboardEvent, now: number): boolean {
  const parts = combo.toLowerCase().split(" ");
  if (parts.length === 1) {
    return e.key.toLowerCase() === parts[0];
  }
  // sequence
  const [prefix, second] = parts;
  if (bufferedPrefix === prefix && now - bufferedAt < 1200 && e.key.toLowerCase() === second) {
    bufferedPrefix = null;
    return true;
  }
  if (e.key.toLowerCase() === prefix && bufferedPrefix !== prefix) {
    bufferedPrefix = prefix;
    bufferedAt = now;
  }
  return false;
}

function rootHandler(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    if (e.key !== "Escape") return;
  }
  const now = Date.now();
  for (const b of registry.values()) {
    if (comboMatches(b.combo, e, now)) {
      e.preventDefault();
      b.handler(e);
      return;
    }
  }
}

let installed = false;
function install() {
  if (installed) return;
  if (typeof window === "undefined") return;
  window.addEventListener("keydown", rootHandler);
  installed = true;
}

export function useKeybindings(bindings: Keybinding[]) {
  const idsRef = useRef<string[]>([]);
  useEffect(() => {
    install();
    const ids: string[] = [];
    for (const b of bindings) {
      const id = `${b.scope ?? "global"}::${b.combo}`;
      registry.set(id, b);
      ids.push(id);
    }
    idsRef.current = ids;
    notify();
    return () => {
      ids.forEach((id) => registry.delete(id));
      notify();
    };
  }, [bindings]);
}

export function useAllKeybindings(): Keybinding[] {
  const [, force] = useState({});
  useEffect(() => {
    const l = () => force({});
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return Array.from(registry.values());
}
