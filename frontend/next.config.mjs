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
  }
};

export default nextConfig;
