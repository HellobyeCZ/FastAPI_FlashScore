"use client";
import { Kicker } from "./Kicker";
import { clsx } from "clsx";

export type Facet = {
  key: string;
  label: string;
  options: { value: string; label: string; count?: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
};

export function Facets({ facets }: { facets: Facet[] }) {
  return (
    <aside className="w-[200px] shrink-0 border-r border-border pr-4">
      {facets.map((f) => (
        <div key={f.key} className="mb-5">
          <Kicker>{f.label}</Kicker>
          <ul className="mt-2 flex flex-col gap-[2px]">
            {f.options.map((o) => {
              const checked = f.selected.includes(o.value);
              return (
                <li key={o.value}>
                  <button
                    onClick={() => f.onChange(
                      checked ? f.selected.filter((v) => v !== o.value) : [...f.selected, o.value]
                    )}
                    className={clsx(
                      "flex w-full items-baseline justify-between border-none px-0 py-0 font-mono text-[11px]",
                      checked ? "text-accent" : "text-text-dim hover:text-text"
                    )}
                  >
                    <span>
                      <span className="mr-2 text-text-faint">{checked ? "[x]" : "[ ]"}</span>
                      {o.label}
                    </span>
                    {o.count !== undefined && <span className="text-text-faint">{o.count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
