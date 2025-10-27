/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true
  },
  i18n: {
    locales: ["en", "cs"],
    defaultLocale: "en"
  }
};

export default nextConfig;
