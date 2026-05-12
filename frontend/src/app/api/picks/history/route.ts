import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 15_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = url.searchParams.get("limit") ?? "200";

  const params = new URLSearchParams({ limit });
  if (status) {
    params.set("status", status);
  }

  const backendUrl = `${resolveBackendBaseUrl()}/picks/history?${params.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(backendUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });

    const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
    const body = await upstreamResponse.text();

    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers: { "content-type": contentType }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach picks backend.";
    return NextResponse.json(
      { error: { code: "picks_backend_unreachable", message } },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
