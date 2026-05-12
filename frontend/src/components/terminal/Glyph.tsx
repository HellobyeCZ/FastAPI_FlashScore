type GlyphKind =
  | "section"   // ▌
  | "item"      // ▸
  | "null"      // ─
  | "up"        // ▲
  | "down"      // ▼
  | "led"       // ●
  | "branch"    // └
  | "full"      // █
  | "empty";    // ░

const MAP: Record<GlyphKind, string> = {
  section: "▌",
  item: "▸",
  null: "─",
  up: "▲",
  down: "▼",
  led: "●",
  branch: "└",
  full: "█",
  empty: "░"
};

export function Glyph({ kind, className }: { kind: GlyphKind; className?: string }) {
  return <span aria-hidden className={className}>{MAP[kind]}</span>;
}

export type { GlyphKind };
