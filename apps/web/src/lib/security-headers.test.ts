import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

describe("security headers (plan 4.5)", () => {
  it("applies the baseline headers to every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all).toBeDefined();
    const headers = new Map(all?.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
    expect(headers.get("strict-transport-security")).toMatch(/includeSubDomains/);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("microphone=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("does not enforce a Content Security Policy yet", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const keys = rules.flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase()));
    expect(keys).not.toContain("content-security-policy");
  });
});

async function allPathHeaders(): Promise<Map<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const all = rules.find((rule) => rule.source === "/:path*");
  return new Map(all?.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe("report only Content Security Policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports to /api/csp-report through report-uri and report-to", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    const headers = await allPathHeaders();
    const policy = directives(headers.get("content-security-policy-report-only") ?? "");
    expect(policy.get("report-uri")).toEqual(["/api/csp-report"]);
    expect(policy.get("report-to")).toEqual(["csp-endpoint"]);
    expect(headers.get("reporting-endpoints")).toBe('csp-endpoint="https://curvi.ai/api/csp-report"');
  });

  it("covers what the app loads: PostHog, Supabase, R2 and Stripe redirects", async () => {
    const policy = directives((await allPathHeaders()).get("content-security-policy-report-only") ?? "");
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toContain("https://*.posthog.com");
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining(["'self'", "https://*.posthog.com", "https://*.supabase.co", "wss://*.supabase.co", "https://*.r2.cloudflarestorage.com"]),
    );
    expect(policy.get("img-src")).toContain("https://*.r2.cloudflarestorage.com");
    expect(policy.get("form-action")).toContain("https://checkout.stripe.com");
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("adds a custom Supabase and PostHog host set at build time", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.curvi.ai");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://e.curvi.ai/ingest");
    const policy = directives((await allPathHeaders()).get("content-security-policy-report-only") ?? "");
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining(["https://auth.curvi.ai", "wss://auth.curvi.ai", "https://e.curvi.ai"]),
    );
  });
});
