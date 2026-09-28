import { describe, expect, it } from "vitest";
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

  it("does not enforce a Content Security Policy in this batch", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const keys = rules.flatMap((rule) => rule.headers.map((h) => h.key.toLowerCase()));
    expect(keys).not.toContain("content-security-policy");
  });
});
