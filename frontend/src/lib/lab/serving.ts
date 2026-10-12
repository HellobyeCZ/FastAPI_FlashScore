"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { backendSend } from "@/lib/api/http";
import { opsStatusKey } from "@/hooks/useOpsStatus";
import { mlflowKeys } from "@/hooks/useMlflow";
import type { ModelVersion, RegisteredModel } from "@/types/mlflow";
import type { ServedModel } from "@/types/ops";

/** Fewer backtest bets than this and a promotion is flagged as thin evidence. */
export const MIN_PROMOTION_BETS = 300;

/** Re-resolve served models (registry @champion, else file artifacts). */
export function useReloadServedModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => backendSend<{ models: ServedModel[] }>("POST", "ml/reload"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opsStatusKey });
      qc.invalidateQueries({ queryKey: mlflowKeys.registry });
    }
  });
}

export function versionMetric(v: ModelVersion | null | undefined, key: string): number | null {
  const x = v?.metrics[key];
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Newest version first (MLflow versions are increasing integers as strings). */
export function sortVersions(versions: ModelVersion[]): ModelVersion[] {
  return [...versions].sort((a, b) => Number(b.version) - Number(a.version));
}

export function aliasVersion(model: RegisteredModel, alias: "champion" | "challenger"): ModelVersion | null {
  const version = model.aliases[alias];
  return version ? (model.versions.find((v) => v.version === version) ?? null) : null;
}

/**
 * How serving relates to the registry for one model:
 * - "synced": serving loaded the registry champion
 * - "stale": a champion exists but serving loaded something else (reload needed)
 * - "orphaned": serving still uses a registry version although no champion is set
 * - "fallback": no champion; serving uses the file artifact
 * - "unserved": no champion and nothing loaded (no file artifact either)
 * - "untracked": the model can't be served from the registry
 */
export type ServingState = "synced" | "stale" | "orphaned" | "fallback" | "unserved" | "untracked";

export function servingState(model: RegisteredModel | undefined, served: ServedModel | undefined): ServingState {
  if (!served?.loaded && !model?.aliases.champion) return "unserved";
  if (model && !model.servable) return "untracked";
  const champion = model?.aliases.champion ?? null;
  const fromRegistry = Boolean(served?.loaded && served.source === "registry");
  if (champion) return fromRegistry && served?.version === champion ? "synced" : "stale";
  return fromRegistry ? "orphaned" : "fallback";
}
