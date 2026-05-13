"use client";
import { useEffect, useRef, useState } from "react";

export function useElementWidth<T extends HTMLElement = HTMLDivElement>(
  initial = 0,
): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      setWidth(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setWidth(Math.floor(cr.width));
      }
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
