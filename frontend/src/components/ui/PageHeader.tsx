import Link from "next/link";
import type { Route } from "next";
import { clsx } from "clsx";

export type Crumb = { label: string; href?: Route };

/**
 * Page title block. Every page renders exactly one, which provides the page's
 * <h1>. Breadcrumbs replace the old "PICKS · MODELS" kicker.
 */
export function PageHeader({
  title,
  crumbs,
  description,
  actions,
  meta,
  className
}: {
  title: React.ReactNode;
  crumbs?: Crumb[];
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Small right-aligned status line, e.g. "as of 18:02 · 52,373 matches". */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={clsx("mb-6 border-b border-border pb-4", className)}>
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1.5 font-sans text-label uppercase tracking-label text-text-dim">
            {crumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-text-faint">/</span>}
                {c.href ? (
                  <Link href={c.href} className="hover:text-text">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-sans text-title font-medium text-text">
            <span aria-hidden className="text-accent">
              ▌
            </span>
            <span className="min-w-0 break-words">{title}</span>
          </h1>
          {description && <p className="mt-1 max-w-prose text-body text-text-dim">{description}</p>}
        </div>
        {(actions || meta) && (
          <div className="flex flex-col items-start gap-2 sm:items-end">
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            {meta && <div className="text-meta text-text-faint">{meta}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
