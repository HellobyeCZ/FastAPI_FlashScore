import { Kicker } from "./Kicker";
import { clsx } from "clsx";

export function Stat({
  label,
  value,
  delta,
  deltaTone,
  children
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "pos" | "neg" | "neutral";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-6 py-4">
      <Kicker>{label}</Kicker>
      <div className="font-mono text-[32px] leading-none tabular-nums text-text">{value}</div>
      {delta && (
        <div className={clsx(
          "font-mono text-[12px] tabular-nums",
          deltaTone === "pos" && "text-pos",
          deltaTone === "neg" && "text-neg",
          (!deltaTone || deltaTone === "neutral") && "text-text-dim"
        )}>
          {delta}
        </div>
      )}
      {children && <div className="mt-1 border-t border-border pt-2">{children}</div>}
    </div>
  );
}
