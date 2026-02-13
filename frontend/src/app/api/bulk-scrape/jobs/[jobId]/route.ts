import { NextResponse } from "next/server";

const DEFAULT_BACKEND_BASE_URL = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 60_000;

function resolveBackendBaseUrl(): string {
  const configured = process.env.ODDS_BACKEND_BASE_URL ?? DEFAULT_BACKEND_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export async function GET(
  request: Request,
  { params }: { params: { jobId: string } }
) {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  const base = `${resolveBackendBaseUrl()}/bulk-scrape/jobs/${encodeURIComponent(params.jobId)}`;
  const backendUrl = query ? `${base}?${query}` : base;
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
    const message = error instanceof Error ? error.message : "Failed to load bulk scrape job.";
    return NextResponse.json(
      {
        error: {
          code: "bulk_scrape_job_load_failed",
          message
        }
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
