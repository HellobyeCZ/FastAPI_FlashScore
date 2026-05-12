"use client";
import { useState, useMemo } from "react";
import { clsx } from "clsx";

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sort?: (a: T, b: T) => number;
  align?: "left" | "right";
  width?: string;
};

export function DataTable<T>({
  columns,
  rows,
  onRowClick,
  empty,
  className
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const copy = [...rows].sort(col.sort);
    if (sortDir === "desc") copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir, columns]);

  function toggleSort(key: string) {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null);
  }

  return (
    <table className={clsx("w-full border-collapse font-mono text-[12px]", className)}>
      <thead>
        <tr className="border-b border-border">
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              onClick={c.sort ? () => toggleSort(c.key) : undefined}
              className={clsx(
                "px-2 py-2 font-sans text-[10px] uppercase text-text-dim",
                c.align === "right" && "text-right",
                c.sort && "cursor-pointer hover:text-text"
              )}
              style={{ letterSpacing: "var(--track-wide)", width: c.width }}
            >
              {c.header}
              {sortKey === c.key && <span className="ml-1 text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 && empty && (
          <tr><td colSpan={columns.length} className="px-2 py-6 text-center text-text-dim">{empty}</td></tr>
        )}
        {sorted.map((row, i) => (
          <tr
            key={i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={clsx(
              "border-b border-border/60",
              onRowClick && "cursor-pointer hover:bg-surface"
            )}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={clsx("px-2 py-1 align-middle", c.align === "right" && "text-right tabular-nums")}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
