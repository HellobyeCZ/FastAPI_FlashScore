"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Skeleton } from "./Skeleton";
import { useSettings } from "@/hooks/useSettings";

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  /** Expanded name for abbreviated headers (tooltip + screen readers). */
  headerTitle?: string;
  cell: (row: T, index: number) => React.ReactNode;
  /** Enables sorting; return null to sort the row last. */
  sortValue?: (row: T) => number | string | null | undefined;
  align?: "left" | "right" | "center";
  /** Hide this column below a breakpoint (column priority on small screens). */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  width?: string;
  className?: string;
  /** Default first-click direction (numbers usually want desc). */
  firstDir?: SortDir;
};

const hideClass = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell"
};

function compare(a: number | string | null | undefined, b: number | string | null | undefined): number {
  const an = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Data table.
 * - Sortable headers are real <button>s with aria-sort on the <th>.
 * - `rowHref` makes the row navigable: the `linkColumn` cell renders a real
 *   <Link> (keyboard reachable) and the whole row is a mouse click target.
 * - Wide tables scroll horizontally inside their own container; use
 *   `hideBelow` on low-priority columns so phones see the essentials.
 * - Controlled (`sort` + `onSortChange`) or uncontrolled (`defaultSort`).
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  rowHref,
  linkColumn,
  rowClassName,
  onRowClick,
  selectedKey,
  sort: controlledSort,
  onSortChange,
  defaultSort = null,
  loading,
  skeletonRows = 6,
  empty,
  footer,
  maxHeight,
  className
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Accessible description of the table (visually hidden). */
  caption: string;
  rowHref?: (row: T) => Route | string | null;
  /** Column whose cell becomes the row's link; defaults to the first column. */
  linkColumn?: string;
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  defaultSort?: SortState;
  loading?: boolean;
  skeletonRows?: number;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  maxHeight?: string;
  className?: string;
}) {
  const router = useRouter();
  const { settings } = useSettings();
  const [innerSort, setInnerSort] = useState<SortState>(defaultSort);
  const sort = controlledSort !== undefined ? controlledSort : innerSort;
  const setSort = (s: SortState) => (onSortChange ? onSortChange(s) : setInnerSort(s));
  const linkCol = linkColumn ?? columns[0]?.key;

  const sorted = useMemo(() => {
    if (!sort || onSortChange) return rows; // controlled sort = server-sorted
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const r = compare(col.sortValue!(a), col.sortValue!(b));
      return sort.dir === "asc" ? r : -r;
    });
    return copy;
  }, [rows, sort, columns, onSortChange]);

  function toggle(col: Column<T>) {
    const first = col.firstDir ?? "desc";
    if (!sort || sort.key !== col.key) return setSort({ key: col.key, dir: first });
    if (sort.dir === first) return setSort({ key: col.key, dir: first === "asc" ? "desc" : "asc" });
    setSort(null);
  }

  const cellPad = settings.dense ? "px-2 py-1" : "px-3 py-2";

  return (
    <div
      className={clsx("relative min-w-0 overflow-x-auto", maxHeight && "overflow-y-auto", className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full border-collapse font-mono text-body">
        <caption className="sr-only">{caption}</caption>
        <thead className={clsx(maxHeight && "sticky top-0 z-10", "bg-bg")}>
          <tr className="border-b border-border-strong">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortValue ? "none" : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={ariaSort}
                  title={c.headerTitle}
                  style={{ width: c.width }}
                  className={clsx(
                    "whitespace-nowrap px-3 py-2 font-sans text-label font-normal uppercase tracking-label text-text-dim",
                    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
                    c.hideBelow && hideClass[c.hideBelow]
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(c)}
                      className={clsx(
                        "inline-flex items-center gap-1 uppercase hover:text-text",
                        active && "text-text",
                        c.align === "right" && "flex-row-reverse"
                      )}
                    >
                      {c.header}
                      <span aria-hidden className={clsx("text-[10px]", active ? "text-accent" : "text-text-faint")}>
                        {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`sk-${i}`} className="border-b border-border">
                {columns.map((c) => (
                  <td key={c.key} className={clsx(cellPad, c.hideBelow && hideClass[c.hideBelow])}>
                    <Skeleton className="h-3 w-3/4" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading && sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="p-0">
                {empty}
              </td>
            </tr>
          )}
          {!loading &&
            sorted.map((row, i) => {
              const key = rowKey(row, i);
              const href = rowHref?.(row) ?? null;
              const clickable = Boolean(href || onRowClick);
              return (
                <tr
                  key={key}
                  aria-selected={selectedKey !== undefined ? selectedKey === key : undefined}
                  onClick={
                    clickable
                      ? (e) => {
                          // Let real links/buttons inside the row handle themselves.
                          if ((e.target as HTMLElement).closest("a,button,input,select,label")) return;
                          if (onRowClick) onRowClick(row);
                          else if (href) {
                            if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
                            else router.push(href as Route);
                          }
                        }
                      : undefined
                  }
                  className={clsx(
                    "border-b border-border",
                    clickable && "cursor-pointer hover:bg-surface-2",
                    selectedKey === key && "bg-surface-2",
                    rowClassName?.(row)
                  )}
                >
                  {columns.map((c) => {
                    const content = c.cell(row, i);
                    return (
                      <td
                        key={c.key}
                        className={clsx(
                          cellPad,
                          "align-middle",
                          c.align === "right" && "text-right tabular-nums",
                          c.align === "center" && "text-center",
                          c.hideBelow && hideClass[c.hideBelow],
                          c.className
                        )}
                      >
                        {href && c.key === linkCol ? (
                          <Link href={href as Route} className="hover:text-accent focus-visible:text-accent">
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
        </tbody>
      </table>
      {footer && <div className="border-t border-border px-3 py-2 text-meta text-text-dim">{footer}</div>}
    </div>
  );
}
