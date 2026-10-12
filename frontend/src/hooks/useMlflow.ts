"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backendGet, backendSend } from "@/lib/api/http";
import { opsStatusKey } from "@/hooks/useOpsStatus";
import type {
  MlflowRunsResponse,
  RegisterRequest,
  RegisterResponse,
  RegistryAlias,
  RegistryResponse,
  SetAliasRequest,
  SetAliasResponse
} from "@/types/mlflow";

export type MlflowRunsFilter = {
  purpose?: string | null;
  model?: string | null;
  limit?: number;
};

export const mlflowKeys = {
  runs: (f: MlflowRunsFilter) => ["mlflow", "runs", f] as const,
  registry: ["mlflow", "registry"] as const
};

export function useMlflowRuns(filter: MlflowRunsFilter = {}) {
  return useQuery({
    queryKey: mlflowKeys.runs(filter),
    queryFn: () =>
      backendGet<MlflowRunsResponse>("mlflow/runs", {
        purpose: filter.purpose ?? undefined,
        model: filter.model ?? undefined,
        limit: filter.limit ?? 200
      }),
    staleTime: 30_000
  });
}

export function useRegistry() {
  return useQuery({
    queryKey: mlflowKeys.registry,
    queryFn: () => backendGet<RegistryResponse>("mlflow/registry"),
    staleTime: 30_000
  });
}

// Served models changed: cached match predictions came from the old ones.
const isPrediction = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === "match" && q.queryKey[2] === "predict";

function useInvalidateMlflow() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["mlflow"] });
    qc.invalidateQueries({ queryKey: opsStatusKey });
    qc.invalidateQueries({ predicate: isPrediction });
  };
}

/** Register a run's logged model as a new version (optionally aliasing it). */
export function useRegisterRun() {
  const invalidate = useInvalidateMlflow();
  return useMutation({
    mutationFn: (req: RegisterRequest) =>
      backendSend<RegisterResponse>("POST", "mlflow/registry/register", req),
    onSuccess: invalidate
  });
}

/** Point `@champion` / `@challenger` at a version. Champion reloads serving. */
export function useSetAlias(modelName: string) {
  const invalidate = useInvalidateMlflow();
  return useMutation({
    mutationFn: (req: SetAliasRequest) =>
      backendSend<SetAliasResponse>("POST", `mlflow/registry/${encodeURIComponent(modelName)}/aliases`, req),
    onSuccess: invalidate
  });
}

export function useDeleteAlias(modelName: string) {
  const invalidate = useInvalidateMlflow();
  return useMutation({
    mutationFn: (alias: RegistryAlias) =>
      backendSend<{ ok: boolean }>(
        "DELETE",
        `mlflow/registry/${encodeURIComponent(modelName)}/aliases/${alias}`
      ),
    onSuccess: invalidate
  });
}
