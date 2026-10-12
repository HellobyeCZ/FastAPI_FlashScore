import "server-only";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";

/** FastAPI base URL for server-side calls (ODDS_BACKEND_BASE_URL). */
export function backendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/$/, "");
}

export type ProxyOptions = {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  search?: string;
  body?: string | null;
  timeoutMs?: number;
};

/**
 * Forward a request to FastAPI and stream the response back unchanged
 * (status, JSON body). Network failures and timeouts become a 502/504 with a
 * JSON `{ error: { code, message } }` body the client can render.
 */
export async function proxyToBackend(path: string, opts: ProxyOptions = {}): Promise<Response> {
  const { method = "GET", search = "", body = null, timeoutMs = 30_000 } = opts;
  const url = `${backendBaseUrl()}/${path.replace(/^\//, "")}${search}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ?? undefined,
      cache: "no-store",
      signal: controller.signal
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" }
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return Response.json(
      {
        error: {
          code: aborted ? "backend_timeout" : "backend_unreachable",
          message: aborted
            ? `Backend did not answer within ${Math.round(timeoutMs / 1000)}s`
            : `Backend unreachable at ${backendBaseUrl()}`
        }
      },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CSRF guard for state-changing requests. The dashboard runs on localhost
 * with no auth, so any website the operator visits could otherwise POST to
 * it (a "simple" cross-site request needs no preflight). Browsers send
 * Sec-Fetch-Site and/or Origin on such requests; anything not same-origin is
 * refused. Requests with neither header (curl, scripts) are allowed.
 */
export function rejectCrossSite(req: Request): Response | null {
  const forbidden = () =>
    Response.json(
      { error: { code: "cross_site", message: "Cross-site requests are not allowed" } },
      { status: 403 }
    );
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return forbidden();
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === host;
    } catch {
      sameHost = false;
    }
    if (!sameHost) return forbidden();
  }
  return null;
}

