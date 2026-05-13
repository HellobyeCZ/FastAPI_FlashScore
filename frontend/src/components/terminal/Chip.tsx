import { clsx } from "clsx";

export function Chip({
  children,
  selected,
  onClick,
  className
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1 border px-2 py-[2px] font-mono text-[11px] uppercase",
        selected
          ? "border-accent text-accent"
          : "border-border text-text-dim hover:border-border-hot hover:text-text",
        className
      )}
      aria-pressed={selected}
    >
      {children}
    </button>
  );
}
