"use client";
import { useQuery } from "@tanstack/react-query";
import { backendGet } from "@/lib/api/http";
import type { OpsStatus } from "@/types/ops";

export const opsStatusKey = ["ops-status"] as const;

/** Shell-wide health. Cheap backend call; refreshed every minute. */
export function useOpsStatus() {
  return useQuery({
    queryKey: opsStatusKey,
    queryFn: () => backendGet<OpsStatus>("ops/status"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 0
  });
}
