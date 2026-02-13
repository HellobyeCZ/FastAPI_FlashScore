import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 60_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

function buildBackendUrl(searchParams: URLSearchParams): string {
  const base = `${resolveBackendBaseUrl()}/bulk-scrape/jobs`;
  const query = searchParams.toString();
  return query ? `${base}?${query}` : base;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const backendUrl = buildBackendUrl(url.searchParams);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(backendUrl, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      cache: "no-store",
      signal: controller.signal
    });

    const body = await upstreamResponse.text();
    return new NextResponse(body, {
      status: upstreamResponse.status,
      headers: {
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/json"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach bulk scrape backend.";
    return NextResponse.json(
      {
        error: {
          code: "bulk_scrape_backend_unreachable",
          message
        }
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const backendUrl = `${resolveBackendBaseUrl()}/bulk-scrape/jobs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body = await request.text();
    const upstreamResponse = await fetch(backendUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body,
      cache: "no-store",
      signal: controller.signal
    });

    const responseBody = await upstreamResponse.text();
    return new NextResponse(responseBody, {
      status: upstreamResponse.status,
      headers: {
        "content-type": upstreamResponse.headers.get("content-type") ?? "application/json"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create bulk scrape job.";
    return NextResponse.json(
      {
        error: {
          code: "bulk_scrape_job_create_failed",
          message
        }
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
