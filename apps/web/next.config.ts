import path from "node:path";
import type { NextConfig } from "next";

/**
 * Baseline security headers on every response (plan 4.5). HSTS for a year
 * across subdomains (browsers ignore it over plain http, so local dev is
 * unaffected); no MIME sniffing; no framing, which blocks clickjacking of the
 * billing and brand pages; referrers trimmed to the origin cross site; and the
 * powerful browser features the app never uses turned off. The Content
 * Security Policy below is report only: browsers send violations to
 * /api/csp-report and block nothing, so the policy can be tuned against real
 * traffic before it is enforced.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/** Where browsers post CSP violation reports (app/api/csp-report). */
const CSP_REPORT_PATH = "/api/csp-report";
/** The Reporting-Endpoints name the report-to directive points at. */
const CSP_REPORT_GROUP = "csp-endpoint";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The report only policy, built from what the app loads today (checked
 * 2026-09-28, docs/verification.md): its own scripts plus Next.js inline
 * bootstrap scripts, PostHog (script-src and connect-src *.posthog.com, as
 * PostHog documents), Supabase auth and realtime, direct uploads to and
 * presigned reads from R2, and redirects to Stripe Checkout and the billing
 * portal. Environment specific origins (a custom Supabase or PostHog host)
 * are added when set at build time.
 */
function contentSecurityPolicy(env: Record<string, string | undefined> = process.env): string {
  const supabase = originOf(env.NEXT_PUBLIC_SUPABASE_URL);
  const posthog = originOf(env.NEXT_PUBLIC_POSTHOG_HOST);
  const r2 = "https://*.r2.cloudflarestorage.com";
  const dev = env.NODE_ENV !== "production";
  const unique = (values: Array<string | null | false>): string =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].join(" ");
  const directives: Array<[string, string]> = [
    ["default-src", "'self'"],
    ["script-src", unique(["'self'", "'unsafe-inline'", dev && "'unsafe-eval'", "https://*.posthog.com", posthog])],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", unique(["'self'", "data:", "blob:", r2])],
    ["font-src", "'self' data:"],
    [
      "connect-src",
      unique([
        "'self'",
        "https://*.supabase.co",
        "wss://*.supabase.co",
        supabase,
        supabase && supabase.replace(/^http/, "ws"),
        "https://*.posthog.com",
        posthog,
        r2,
      ]),
    ],
    ["media-src", unique(["'self'", "blob:", r2])],
    ["worker-src", "'self' blob:"],
    ["frame-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self' https://checkout.stripe.com https://billing.stripe.com"],
    ["frame-ancestors", "'none'"],
    ["report-uri", CSP_REPORT_PATH],
    ["report-to", CSP_REPORT_GROUP],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** Reporting API endpoint for report-to. MDN only documents absolute URLs
 * here, so it is built from the site URL; report-uri covers browsers
 * without the Reporting API. */
function reportingEndpoints(env: Record<string, string | undefined> = process.env): string {
  const site = originOf(env.NEXT_PUBLIC_SITE_URL) ?? "http://localhost:3000";
  return `${CSP_REPORT_GROUP}="${site}${CSP_REPORT_PATH}"`;
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...securityHeaders,
          { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
          { key: "Reporting-Endpoints", value: reportingEndpoints() },
        ],
      },
    ];
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
