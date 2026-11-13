import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  outputFileTracingIncludes: {
    "/api/team/timesheets": ["./public/fonts/*", "./public/brand/*"],
  },
};

export default nextConfig;
