import { clsx } from "clsx";

export function Kicker({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "font-sans uppercase text-text-dim",
        "text-[10px]",
        className
      )}
      style={{ letterSpacing: "var(--track-wide)" }}
    >
      {children}
    </span>
  );
}
