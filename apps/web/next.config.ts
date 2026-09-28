import path from "node:path";
import type { NextConfig } from "next";

/**
 * Baseline security headers on every response (plan 4.5). HSTS for a year
 * across subdomains (browsers ignore it over plain http, so local dev is
 * unaffected); no MIME sniffing; no framing, which blocks clickjacking of the
 * billing and brand pages; referrers trimmed to the origin cross site; and the
 * powerful browser features the app never uses turned off. A Content Security
 * Policy is deliberately not enforced in this batch.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["@curvi/ui", "@curvi/specs", "@curvi/db", "@curvi/pipeline", "@curvi/ai", "@curvi/trigger"],
  serverExternalPackages: ["sharp", "exiftool-vendored", "archiver", "postgres", "@trigger.dev/sdk"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // serverExternalPackages only externalizes imports issued from
      // node_modules. The inline pack runner is transpiled workspace source
      // (@curvi/trigger -> @curvi/pipeline) whose native and SDK imports must
      // stay require() calls at runtime.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        {
          sharp: "commonjs sharp",
          "exiftool-vendored": "commonjs exiftool-vendored",
          archiver: "commonjs archiver",
          postgres: "commonjs postgres",
          "@trigger.dev/sdk/v3": "commonjs @trigger.dev/sdk/v3",
          "@aws-sdk/client-s3": "commonjs @aws-sdk/client-s3",
        },
      ];
    }
    return config;
  },
  eslint: {
    // Linting runs at the repo root with the shared flat config.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
