import { clsx } from "clsx";

export function KeyHint({ keys, className }: { keys: string | string[]; className?: string }) {
  const list = Array.isArray(keys) ? keys : keys.split("+");
  return (
    <span className={clsx("inline-flex items-center gap-[2px] font-mono text-[10px]", className)}>
      <span className="text-text-faint">[</span>
      {list.map((k, i) => (
        <span key={i} className="text-text-dim">
          {i > 0 && <span className="text-text-faint mx-[2px]">+</span>}
          {k.toUpperCase()}
        </span>
      ))}
      <span className="text-text-faint">]</span>
    </span>
  );
}
