import { proxyToBackend, rejectCrossSite } from "@/lib/server/backend";

export const dynamic = "force-dynamic";

/**
 * Explicit "fetch latest from FlashScore" for match statistics: FastAPI
 * GET /match-stats/{id} scrapes upstream (unless a terminal snapshot exists)
 * and stores a new stats snapshot. Pages never call this on load — stored
 * stats come from /api/backend/events/{id}/stats — only the confirmed action
 * on the match page does.
 */
// POST (not GET) so a cross-site <img> or link can never trigger an upstream
// scrape; same-origin only.
export async function POST(req: Request, { params }: { params: { eventId: string } }) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  return proxyToBackend(`match-stats/${encodeURIComponent(params.eventId)}`, { timeoutMs: 45_000 });
}
