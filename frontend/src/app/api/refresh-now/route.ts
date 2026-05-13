import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 60_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

async function proxy(method: "GET" | "POST", request: Request) {
  const url = new URL(request.url);
  const backendUrl = `${resolveBackendBaseUrl()}/refresh-now${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init: RequestInit = {
      method,
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    };
    const upstream = await fetch(backendUrl, init);
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "refresh backend unreachable";
    return NextResponse.json(
      { error: { code: "refresh_now_backend_unreachable", message } },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const GET = (req: Request) => proxy("GET", req);
export const POST = (req: Request) => proxy("POST", req);
