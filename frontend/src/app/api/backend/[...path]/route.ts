import { proxyToBackend, rejectCrossSite } from "@/lib/server/backend";

/**
 * Catch-all proxy: /api/backend/<path> → FastAPI /<path>.
 *
 * Allowlisted on purpose. Endpoints that scrape FlashScore upstream
 * (/odds/{id}, /match-stats/{id}) are NOT reachable here — opening a page must
 * never cost upstream requests. Explicit "fetch live" actions use their own
 * dedicated routes (/api/odds, /api/match-stats).
 */
export const dynamic = "force-dynamic";

type Rule = { method: string; pattern: RegExp; timeoutMs?: number };

const RULES: Rule[] = [
  { method: "GET", pattern: /^ops\/status$/ },
  { method: "GET", pattern: /^picks\/(stats|stats\/calibration|history|summary|facets|upcoming)$/ },
  { method: "GET", pattern: /^predict\/[^/]+$/ },
  { method: "GET", pattern: /^storage\/(odds|match-stats)\/[^/]+$/ },
  { method: "GET", pattern: /^events\/[^/]+(\/(odds|stats|picks))?$/ },
  { method: "GET", pattern: /^backtest\/(models|runs)$/ },
  { method: "GET", pattern: /^backtest\/runs\/[^/]+(\/bets)?$/ },
  { method: "POST", pattern: /^backtest\/runs$/ },
  { method: "POST", pattern: /^backtest\/runs\/[^/]+\/cancel$/ },
  { method: "DELETE", pattern: /^backtest\/runs\/[^/]+$/ },
  { method: "GET", pattern: /^bulk-scrape\/jobs(\/\d+)?$/ },
  { method: "POST", pattern: /^bulk-scrape\/jobs$/, timeoutMs: 60_000 },
  { method: "POST", pattern: /^bulk-scrape\/jobs\/\d+\/cancel$/ },
  { method: "GET", pattern: /^refresh-now(\/[^/]+)?$/ },
  { method: "POST", pattern: /^refresh-now$/, timeoutMs: 60_000 },
  { method: "GET", pattern: /^mlflow\/(status|runs|registry)$/ },
  { method: "GET", pattern: /^mlflow\/runs\/[^/]+$/ },
  { method: "POST", pattern: /^mlflow\/registry\/register$/, timeoutMs: 120_000 },
  { method: "POST", pattern: /^mlflow\/registry\/[^/]+\/aliases$/, timeoutMs: 120_000 },
  { method: "DELETE", pattern: /^mlflow\/registry\/[^/]+\/aliases\/[^/]+$/, timeoutMs: 120_000 },
  { method: "POST", pattern: /^ml\/reload$/, timeoutMs: 120_000 }
];

async function handle(req: Request, params: { path: string[] }): Promise<Response> {
  const path = params.path.map(encodeURIComponent).join("/");
  const rule = RULES.find((r) => r.method === req.method && r.pattern.test(path));
  if (!rule) {
    return Response.json(
      { error: { code: "not_allowed", message: `${req.method} /${path} is not proxied` } },
      { status: 404 }
    );
  }
  if (req.method !== "GET") {
    const refused = rejectCrossSite(req);
    if (refused) return refused;
  }
  const url = new URL(req.url);
  const body = req.method === "GET" || req.method === "DELETE" ? null : await req.text();
  // Bodies are forwarded as JSON, so only accept JSON (no text/plain or
  // form posts relabelled on the way through).
  if (body && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json(
      { error: { code: "unsupported_media_type", message: "Request body must be application/json" } },
      { status: 415 }
    );
  }
  return proxyToBackend(path, {
    method: req.method as "GET" | "POST" | "DELETE",
    search: url.search,
    body: body || null,
    timeoutMs: rule.timeoutMs
  });
}

export async function GET(req: Request, ctx: { params: { path: string[] } }) {
  return handle(req, ctx.params);
}
export async function POST(req: Request, ctx: { params: { path: string[] } }) {
  return handle(req, ctx.params);
}
export async function DELETE(req: Request, ctx: { params: { path: string[] } }) {
  return handle(req, ctx.params);
}
