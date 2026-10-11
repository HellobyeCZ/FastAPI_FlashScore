import { forwardRef, useId } from "react";
import { clsx } from "clsx";

/** Small uppercase label used above controls, in stats and panel headers. */
export function Label({
  htmlFor,
  children,
  className,
  as: As = "label"
}: {
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  as?: "label" | "span" | "div";
}) {
  return (
    <As
      {...(As === "label" ? { htmlFor } : {})}
      className={clsx("font-sans text-label uppercase tracking-label text-text-dim", className)}
    >
      {children}
    </As>
  );
}

/**
 * Label + control + hint/error, wired with ids for screen readers.
 * Render-prop gives the control its id and aria-describedby.
 */
export function Field({
  label,
  hint,
  error,
  inline,
  className,
  children
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  inline?: boolean;
  className?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={clsx(inline ? "flex items-center gap-2" : "flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="text-meta text-text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-meta text-neg">
          {error}
        </p>
      )}
    </div>
  );
}

const control =
  "h-9 border border-border-strong bg-bg px-2.5 font-mono text-body text-text placeholder:text-text-faint " +
  "hover:border-text-dim focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={clsx(control, "min-w-0", className)} {...rest} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className={clsx("relative inline-flex", className)}>
        <select
          ref={ref}
          className={clsx(control, "w-full appearance-none pr-7")}
          {...rest}
        >
          {children}
        </select>
        <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-dim">
          ▾
        </span>
      </span>
    );
  }
);

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 cursor-pointer accent-[rgb(var(--accent))] disabled:cursor-not-allowed"
      />
      <label htmlFor={id} className="cursor-pointer text-body text-text">
        {label}
        {hint && <span className="block text-meta text-text-faint">{hint}</span>}
      </label>
    </div>
  );
}

/** Search input with a leading glyph; marks itself as the `/` shortcut target. */
export const SearchInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label: string }
>(function SearchInput({ label, className, ...rest }, ref) {
  return (
    <span className={clsx("relative flex min-w-0 items-center", className)}>
      <span aria-hidden className="pointer-events-none absolute left-2.5 text-text-faint">
        ⌕
      </span>
      <input
        ref={ref}
        type="search"
        aria-label={label}
        data-search-input
        className={clsx(control, "w-full pl-7")}
        {...rest}
      />
      <kbd className="pointer-events-none absolute right-2 hidden border border-border px-1 text-label text-text-faint sm:inline">
        /
      </kbd>
    </span>
  );
});
