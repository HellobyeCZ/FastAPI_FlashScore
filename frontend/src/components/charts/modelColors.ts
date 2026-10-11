// Shared model color palette so a given model renders consistently across
// Explore, Models, ModelDeepDive, and any future surface. Values are token
// references rather than hex; consumers passing the map into visx (which
// requires hex) can fall back via `resolveModelColor`.
export const MODEL_COLOR_VARS: Record<string, string> = {
  dixon_coles: "var(--accent)",
  hgb: "var(--warn)",
  logistic: "var(--neg)",
};

// Concrete hex fallbacks used when visx needs a static color string.
// Picked to map roughly to the token palette in tokens.css.
export const MODEL_COLORS: Record<string, string> = {
  dixon_coles: "#c8f000",
  hgb: "#f5a623",
  logistic: "#ff5577",
};

export const MODEL_COLOR_DEFAULT = "#7a7a7a";

export function colorForModel(model: string): string {
  return MODEL_COLORS[model] ?? MODEL_COLOR_DEFAULT;
}
