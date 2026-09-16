import type { NextConfig } from "next";

const securityHeaders = [
  // In-app calling needs the microphone on our own origin only.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    // Pin the root to this project: Turbopack otherwise walks up to any lockfile in a parent folder
    // (e.g. a stray package-lock.json in Downloads) and warns or resolves from the wrong directory.
    root: __dirname,
  },
  experimental: {
    serverActions: {
      // CSV import sends lead batches of 500 rows through a server action.
      bodySizeLimit: "4mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
