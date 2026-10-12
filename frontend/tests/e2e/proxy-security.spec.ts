import { expect, test } from "@playwright/test";

// The dashboard runs on localhost without auth, so its API must not act on
// requests other websites make through the operator's browser. These hit the
// real Next.js routes; the backend is unreachable in tests (port 9), so a
// request that gets past the guards answers 502 instead of doing anything.
test.describe("API proxy safety", () => {
  test.skip(({ isMobile }) => isMobile, "server-side behaviour; run once");

  test("refuses cross-site state changes", async ({ request }) => {
    const res = await request.post("/api/backend/refresh-now", {
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      data: {}
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("cross_site");

    const fetchSite = await request.post("/api/backend/mlflow/registry/logistic/aliases", {
      headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      data: { version: "1", alias: "champion" }
    });
    expect(fetchSite.status()).toBe(403);
  });

  test("only forwards JSON bodies", async ({ request, baseURL }) => {
    const res = await request.post("/api/backend/backtest/runs", {
      headers: { Origin: new URL(baseURL!).origin, "Content-Type": "text/plain" },
      data: '{"model":"logistic","train_until":"2024-08-01T00:00:00Z"}'
    });
    expect(res.status()).toBe(415);
  });

  test("same-origin JSON passes the guards", async ({ request, baseURL }) => {
    const res = await request.post("/api/backend/refresh-now", {
      headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" },
      data: {}
    });
    expect(res.status()).toBe(502); // reached the (unreachable) backend
  });

  test("upstream fetches are same-origin POSTs only", async ({ request }) => {
    expect((await request.get("/api/odds/xSeyNx8N")).status()).toBe(405);
    const crossSite = await request.post("/api/match-stats/xSeyNx8N", {
      headers: { Origin: "https://evil.example" }
    });
    expect(crossSite.status()).toBe(403);
  });

  test("the proxy never exposes the scraping endpoints", async ({ request }) => {
    for (const path of ["odds/xSeyNx8N", "match-stats/xSeyNx8N", "odds%2FxSeyNx8N"]) {
      expect((await request.get(`/api/backend/${path}`)).status()).toBe(404);
    }
  });
});
