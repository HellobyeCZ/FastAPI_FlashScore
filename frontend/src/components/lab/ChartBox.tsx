"use client";
import { clsx } from "clsx";
import { useElementWidth } from "@/hooks/useElementWidth";
import { Skeleton } from "@/components/ui";

/**
 * Measures its own width and hands it to a chart, so charts never exceed
 * their column (the chart components default to fixed desktop sizes).
 */
export function ChartBox({
  height,
  className,
  children
}: {
  height: number;
  className?: string;
  children: (width: number) => React.ReactNode;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} className={clsx("w-full min-w-0", className)} style={{ minHeight: height }}>
      {width > 0 ? (
        children(width)
      ) : (
        <div style={{ height }}>
          <Skeleton className="h-full w-full" />
        </div>
      )}
    </div>
  );
}
