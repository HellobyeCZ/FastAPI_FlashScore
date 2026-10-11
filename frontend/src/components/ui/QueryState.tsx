"use client";
import type { UseQueryResult } from "@tanstack/react-query";
import { Callout } from "./Callout";
import { Button } from "./Button";
import { Skeleton } from "./Skeleton";
import { useLocale } from "@/contexts/LocaleContext";
import { errorMessage } from "@/lib/api/http";

/**
 * Standard loading / error / empty handling for a React Query result.
 *   <QueryState query={q} isEmpty={(d) => d.rows.length === 0} empty={<EmptyState …/>}>
 *     {(data) => <Table rows={data.rows} …/>}
 *   </QueryState>
 */
export function QueryState<T>({
  query,
  children,
  isEmpty,
  empty,
  loading,
  errorTitle
}: {
  query: Pick<UseQueryResult<T>, "data" | "error" | "isLoading" | "isError" | "refetch" | "isFetching">;
  children: (data: T) => React.ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loading?: React.ReactNode;
  errorTitle?: React.ReactNode;
}) {
  const { t } = useLocale();
  if (query.isLoading) return <>{loading ?? <Skeleton lines={4} className="py-2" />}</>;
  if (query.isError) {
    return (
      <Callout
        tone="neg"
        title={errorTitle ?? t("common.error")}
        action={
          <Button size="sm" onClick={() => query.refetch()} loading={query.isFetching}>
            {t("common.retry")}
          </Button>
        }
      >
        {errorMessage(query.error)}
      </Callout>
    );
  }
  if (query.data === undefined) return null;
  if (isEmpty?.(query.data)) return <>{empty ?? null}</>;
  return <>{children(query.data)}</>;
}
