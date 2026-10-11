/**
 * Browser-side fetch helpers. All FastAPI calls go through the allowlisted
 * proxy at /api/backend/<path>; errors surface as ApiError with the backend's
 * `{ error: { code, message } }` or FastAPI `{ detail }` message attached.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Params = Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>;

export function toSearch(params?: Params): string {
  if (!params) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(","));
    } else {
      p.set(k, String(v));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error?.message) {
      code = body.error.code ?? code;
      message = body.error.message;
    } else if (typeof body?.detail === "string") {
      message = body.detail;
    } else if (Array.isArray(body?.detail) && body.detail[0]?.msg) {
      message = body.detail.map((d: { msg: string }) => d.msg).join("; ");
    }
  } catch {
    // non-JSON body: keep status text
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (err) {
    throw new ApiError(0, "network", err instanceof Error ? err.message : "Network error");
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET /api/backend/<path>?params */
export function backendGet<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  return request<T>(`/api/backend/${path.replace(/^\//, "")}${toSearch(params)}`, init);
}

/** POST/DELETE /api/backend/<path> with an optional JSON body. */
export function backendSend<T>(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  return request<T>(`/api/backend/${path.replace(/^\//, "")}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** GET a Next.js-owned API route (Prisma-backed): /api/<path>. */
export function appGet<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  return request<T>(`/api/${path.replace(/^\//, "")}${toSearch(params)}`, init);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
