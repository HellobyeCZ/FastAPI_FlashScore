import type { Column, SortState } from "@/components/ui";

/** "roi:desc" ⇄ { key: "roi", dir: "desc" } — sort state kept in the URL. */
export function parseSort(raw: string | null): SortState {
  if (!raw) return null;
  const [key, dir] = raw.split(":");
  return key && (dir === "asc" || dir === "desc") ? { key, dir } : null;
}

export function formatSort(sort: SortState): string | null {
  return sort ? `${sort.key}:${sort.dir}` : null;
}

const missing = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

/** Client-side sort by a column's `sortValue`; missing values always last. */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState): T[] {
  const col = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !col?.sortValue) return rows;
  const value = col.sortValue;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (missing(va) || missing(vb)) return missing(va) === missing(vb) ? 0 : missing(va) ? 1 : -1;
    const r = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return r * sign;
  });
}
