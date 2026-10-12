// Owned by the settings page. Keys must be prefixed "settings.".
export const settings = {
  "settings.title": "Settings",
  "settings.description": "Preferences for this browser. Changes apply immediately.",

  "settings.language.title": "Language",
  "settings.language.description": "Switches every page; you stay on the page you're on.",
  "settings.language.label": "Interface language",

  "settings.display.title": "Display",
  "settings.display.description": "How dense and how retro the terminal looks.",
  "settings.dense": "Compact tables",
  "settings.dense.hint": "Tighter row padding, so more rows fit on screen.",
  "settings.scanlines": "CRT scanlines",
  "settings.scanlines.hint": "A faint raster overlay. Purely decorative.",

  "settings.today.title": "Today defaults",
  "settings.today.description": "What the Today slate shows when you open it.",
  "settings.minEdge.label": "Minimum edge",
  "settings.minEdge.all": "All",
  "settings.minEdge.hint": "Picks below this edge are hidden at first. You can still change the filter on Today.",

  "settings.about.title": "About",
  "settings.about.description": "Which builds are running and whether the backend answers.",
  "settings.about.frontend": "Frontend build",
  "settings.about.backend": "Backend build",
  "settings.about.status": "Backend status",
  "settings.about.db": "Database size",
  "settings.about.checked": "Status generated",
  "settings.about.ops": "Open Data ops",
  "settings.about.error": "The backend isn't answering",
  "settings.about.errorHint": "Start FastAPI (uvicorn src:app on port 8000), then retry."
} as const;
