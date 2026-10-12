import Link from "next/link";
import type { Route } from "next";
import { forwardRef } from "react";
import { clsx } from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 border font-mono text-meta uppercase tracking-[0.06em] " +
  "transition-colors select-none whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "border-accent bg-accent text-accent-ink hover:bg-accent/85",
  secondary: "border-border-strong bg-transparent text-text hover:border-text-dim hover:bg-surface-2",
  ghost: "border-transparent bg-transparent text-text-dim hover:bg-surface-2 hover:text-text",
  danger: "border-neg/70 bg-transparent text-neg hover:bg-neg/10"
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5",
  md: "h-9 px-3.5"
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return clsx(base, variants[variant], sizes[size], className);
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  external,
  ...rest
}: {
  href: Route | string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
  external?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = buttonClass(variant, size, className);
  if (external) {
    return (
      <a href={href} className={cls} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        <span aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <Link href={href as Route} className={cls} {...rest}>
      {children}
    </Link>
  );
}

/** Inline text link with a visible affordance (underline on hover, accent). */
export function TextLink({
  href,
  external,
  className,
  children
}: {
  href: Route | string;
  external?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const cls = clsx(
    "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent",
    className
  );
  if (external) {
    return (
      <a href={href} className={cls} target="_blank" rel="noopener noreferrer">
        {children}
        <span aria-hidden> ↗</span>
      </a>
    );
  }
  return (
    <Link href={href as Route} className={cls}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-block h-3 w-3 animate-spin border border-current border-t-transparent", className)}
      style={{ borderRadius: "50%" }}
    />
  );
}
