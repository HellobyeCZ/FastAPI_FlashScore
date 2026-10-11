"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Button } from "./Button";
import { useLocale } from "@/contexts/LocaleContext";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: role="dialog", aria-modal, labelled by its title, focus
 * trapped while open, Escape closes, focus restored to the opener on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** When false (e.g. while a request is in flight) Escape/backdrop do nothing. */
  dismissible?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const { t } = useLocale();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open || !mounted) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:pt-[10vh]">
      <div
        aria-hidden
        className="fixed inset-0 bg-bg/85 backdrop-blur-[1px]"
        onClick={() => dismissible && onClose()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={clsx(
          "relative w-full border border-border-strong bg-surface shadow-[0_0_0_1px_rgb(var(--bg))] focus:outline-none",
          size === "sm" && "max-w-md",
          size === "md" && "max-w-xl",
          size === "lg" && "max-w-3xl"
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-sans text-lead font-medium text-text">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-body text-text-dim">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close")}>
              esc
            </Button>
          )}
        </div>
        {children && <div className="px-5 py-4">{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  );
}

/**
 * Confirmation for consequential actions (promote a model, start an upstream
 * scrape, delete a run). States the consequence in the body, not just "Sure?".
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  tone = "primary",
  busy,
  error
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  tone?: "primary" | "danger";
  busy?: boolean;
  error?: React.ReactNode;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-body text-text-dim">
        {children}
        {error && <p className="text-neg" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
