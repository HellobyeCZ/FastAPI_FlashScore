"use client";
import { useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, ConfirmDialog } from "@/components/ui";
import type { ButtonSize, ButtonVariant } from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import { isActiveRun, useCancelBacktest, useDeleteBacktest, type BacktestRunSummary } from "@/lib/lab/backtests";
import { runTitle } from "@/lib/lab/format";

/**
 * Cancel (queued/running) or delete (finished) a run, each behind a
 * confirmation that names the run and states what happens to its data.
 */
export function RunActions({
  run,
  size = "sm",
  variant = "ghost",
  onDeleted
}: {
  run: BacktestRunSummary;
  size?: ButtonSize;
  variant?: ButtonVariant;
  onDeleted?: () => void;
}) {
  const { t, tp, fmt, locale } = useLocale();
  const [open, setOpen] = useState<"cancel" | "delete" | null>(null);
  const cancel = useCancelBacktest();
  const remove = useDeleteBacktest();
  const title = runTitle(run, locale, t);
  const active = isActiveRun(run);

  function close() {
    setOpen(null);
    cancel.reset();
    remove.reset();
  }

  return (
    <>
      {active ? (
        <Button
          size={size}
          variant={variant}
          onClick={() => setOpen("cancel")}
          aria-label={t("lab.action.cancelNamed", { title })}
        >
          {t("lab.action.cancel")}
        </Button>
      ) : (
        <Button
          size={size}
          variant={variant}
          onClick={() => setOpen("delete")}
          aria-label={t("lab.action.deleteNamed", { title })}
        >
          {t("common.delete")}
        </Button>
      )}

      <ConfirmDialog
        open={open === "cancel"}
        onClose={close}
        onConfirm={() => cancel.mutate(run.id, { onSuccess: close })}
        title={t("lab.cancel.title")}
        confirmLabel={t("lab.cancel.confirm")}
        tone="danger"
        busy={cancel.isPending}
        error={cancel.error ? errorMessage(cancel.error) : null}
      >
        <p className="text-text">{title}</p>
        <p>{t(run.status === "queued" ? "lab.cancel.queued" : "lab.cancel.running")}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={open === "delete"}
        onClose={close}
        onConfirm={() =>
          remove.mutate(run.id, {
            onSuccess: () => {
              close();
              onDeleted?.();
            }
          })
        }
        title={t("lab.delete.title")}
        confirmLabel={t("lab.delete.confirm")}
        tone="danger"
        busy={remove.isPending}
        error={remove.error ? errorMessage(remove.error) : null}
      >
        <p className="text-text">{title}</p>
        <p>
          {run.total_bets
            ? t("lab.delete.bodyBets", { bets: tp("lab.bets", run.total_bets, { n: fmt.int(run.total_bets) }) })
            : t("lab.delete.body")}
        </p>
        {run.mlflow_run_id && <p>{t("lab.delete.mlflowKept")}</p>}
      </ConfirmDialog>
    </>
  );
}
