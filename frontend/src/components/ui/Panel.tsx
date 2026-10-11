import { useId } from "react";
import { clsx } from "clsx";

/**
 * Bordered section with an optional header (title + description + actions).
 * Renders a <section> labelled by its title so screen readers get landmarks.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  padding = "md",
  className,
  bodyClassName,
  children,
  id
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  padding?: "none" | "sm" | "md";
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  id?: string;
}) {
  const autoId = useId();
  const titleId = title ? `${id ?? autoId}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={clsx("min-w-0 border border-border bg-surface/60", className)}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 id={titleId} className="font-sans text-label uppercase tracking-label text-text">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-meta text-text-dim">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div
        className={clsx(
          padding === "md" && "p-4",
          padding === "sm" && "p-2",
          padding === "none" && "p-0",
          bodyClassName
        )}
      >
        {children}
      </div>
      {footer && <footer className="border-t border-border px-4 py-2 text-meta text-text-dim">{footer}</footer>}
    </section>
  );
}
