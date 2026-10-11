import { execSync } from "node:child_process";

let sha = "dev";
try {
  sha = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true
  },
  env: {
    NEXT_PUBLIC_BUILD_SHA: sha
  },
  // Old information architecture → new. Query strings are preserved.
  async redirects() {
    return [
      { source: "/:locale(en|cs)/odds", destination: "/:locale/matches", permanent: false },
      { source: "/:locale(en|cs)/jobs", destination: "/:locale/ops", permanent: false },
      { source: "/:locale(en|cs)/picks", destination: "/:locale/performance", permanent: false },
      { source: "/:locale(en|cs)/picks/models", destination: "/:locale/performance", permanent: false },
      { source: "/:locale(en|cs)/picks/explore", destination: "/:locale/performance/explore", permanent: false },
      { source: "/:locale(en|cs)/picks/health", destination: "/:locale/ops", permanent: false },
      { source: "/:locale(en|cs)/picks/model/:name", destination: "/:locale/models/:name", permanent: false }
    ];
  }
};

export default nextConfig;
