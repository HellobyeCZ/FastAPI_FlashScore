// FlashScore writes the competition stage into the `competition` text itself
// (e.g. "NHL - Play Offs", "Extraliga - Relegation"), in addition to the
// dedicated `competition_stage` column. For grouping + display we strip the
// suffix so a single "NHL" label covers regular season + every play-off stage.
export function competitionRoot(c: string | null | undefined): string | undefined {
  if (!c) return undefined;
  const idx = c.indexOf(" - ");
  return idx > 0 ? c.slice(0, idx) : c;
}
