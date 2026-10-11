"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout } from "@/components/ui";
import type { MlflowStatus } from "@/types/ops";

/**
 * Explains why MLflow data is missing (disabled vs unreachable) and how to
 * fix it. Renders nothing while the tracking server is reachable.
 */
export function MlflowStatusCallout({
  status,
  onRetry,
  retrying,
  className
}: {
  status: MlflowStatus | null | undefined;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  if (!status || (status.enabled && status.reachable)) return null;
  if (!status.enabled) {
    return (
      <Callout tone="info" title={t("lab.mlflow.disabled.title")} className={className}>
        {t("lab.mlflow.disabled.body")}
      </Callout>
    );
  }
  return (
    <Callout
      tone="warn"
      title={t("lab.mlflow.down.title")}
      className={className}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry} loading={retrying}>
            {t("common.retry")}
          </Button>
        )
      }
    >
      <p>{t("lab.mlflow.down.body", { uri: status.tracking_uri ?? "—" })}</p>
      <p className="mt-1">
        {t("lab.mlflow.down.howto.before")} <code className="font-mono text-text">make mlflow</code>{" "}
        {t("lab.mlflow.down.howto.after", { url: "http://127.0.0.1:5050" })}
      </p>
      {status.error && <p className="mt-1 break-words font-mono text-meta text-text-faint">{status.error}</p>}
    </Callout>
  );
}
