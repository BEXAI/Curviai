import type { CspViolation } from "./csp-report";

const DIRECTIVES = new Set(["default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src", "connect-src", "media-src", "worker-src", "frame-src", "object-src", "base-uri", "form-action", "frame-ancestors"]);

/** Bounded dimensions prevent anonymous reports from creating arbitrary keys. */
function reportHost(value: string | null, site: string): string {
  if (["inline", "eval", "data:", "blob:"].includes(value ?? "")) return value!;
  try {
    const host = new URL(value ?? "").hostname;
    if (host === new URL(site).hostname) return "self";
    for (const domain of ["supabase.co", "posthog.com", "openai.com", "cloudflare.com", "r2.cloudflarestorage.com", "stripe.com", "chatgpt.com", "sentry.io"]) {
      if (host === domain || host.endsWith(`.${domain}`)) return domain;
    }
  } catch { /* A malformed or extension URL shares the bounded other bucket. */ }
  return "other";
}

export function cspCountDeltas(reports: CspViolation[], site: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const report of reports) {
    const directive = DIRECTIVES.has(report.directive ?? "") ? report.directive! : "other";
    const key = `csp|${day}|${directive}|${reportHost(report.blockedUrl, site)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, delta]) => ({ key, delta }));
}

export async function recordCspCounts(reports: CspViolation[]) {
  if (!process.env.DATABASE_URL || reports.length === 0) return;
  const [{ PgCapStore }, { getDb }] = await Promise.all([import("@curvi/trigger/cap-store"), import("./services/db")]);
  await new PgCapStore(getDb()).addMany(cspCountDeltas(reports, process.env.NEXT_PUBLIC_SITE_URL ?? "https://curvi.ai"));
}
