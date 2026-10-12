import { proxyToBackend, rejectCrossSite } from "@/lib/server/backend";

export const dynamic = "force-dynamic";

/**
 * Explicit "fetch latest from FlashScore" for odds: FastAPI GET /odds/{id}
 * scrapes upstream (unless the match is terminal, when it serves the frozen
 * snapshot) and stores a new odds snapshot. Pages never call this on load —
 * stored odds come from /api/backend/events/{id}/odds — only the confirmed
 * action on the match page does.
 */
// POST (not GET) so a cross-site <img> or link can never trigger an upstream
// scrape; same-origin only.
export async function POST(req: Request, { params }: { params: { eventId: string } }) {
  const refused = rejectCrossSite(req);
  if (refused) return refused;
  return proxyToBackend(`odds/${encodeURIComponent(params.eventId)}`, { timeoutMs: 45_000 });
}
