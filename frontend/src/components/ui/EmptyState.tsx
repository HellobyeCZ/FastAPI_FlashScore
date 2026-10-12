import { clsx } from "clsx";

/**
 * Explains why there is nothing to show and what to do next. Never render a
 * bare "no data": say which filter/window produced the empty result and offer
 * the action that fixes it.
 */
export function EmptyState({
  title,
  children,
  action,
  compact,
  className
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "px-4 py-6" : "px-6 py-12",
        className
      )}
    >
      <div aria-hidden className="font-mono text-text-faint">
        ░░░
      </div>
      <p className="font-sans text-lead text-text">{title}</p>
      {children && <div className="max-w-prose text-body text-text-dim">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
