"use client";
import { useEffect, useRef } from "react";

/**
 * Calls `onSettled` when an item that was active in the previous data is no
 * longer active (finished, failed or cancelled). Lists that poll while work
 * runs use it to refresh views derived from that work once it completes.
 */
export function useSettledEffect<T>(
  items: readonly T[] | undefined,
  idOf: (item: T) => string | number,
  isActive: (item: T) => boolean,
  onSettled: () => void
): void {
  const active = useRef<Set<string | number> | null>(null);
  const callback = useRef(onSettled);
  callback.current = onSettled;
  useEffect(() => {
    if (!items) return;
    const now = new Set(items.filter(isActive).map(idOf));
    const previous = active.current;
    active.current = now;
    if (previous && Array.from(previous).some((id) => !now.has(id))) callback.current();
    // idOf/isActive are pure and stable in practice; items drives the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}
