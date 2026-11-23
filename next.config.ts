import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/finance/imports/onda/preview": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
    "/api/team/timesheets": ["./public/fonts/*", "./public/brand/*"],
    "/api/team/payroll-reports": ["./public/fonts/*", "./public/brand/*"],
  },
};

export default nextConfig;
