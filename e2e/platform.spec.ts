import { expect, test } from "@playwright/test";

// Batch 2 platform (docs/phases/PHASE_11.md, b2/platform). Demo mode: no env
// vars, so these check the report only CSP, its report endpoint and that the
// cron route refuses callers while CRON_SECRET is unset. Cookie consent only
// appears with a PostHog key and is covered by src/lib/consent.test.ts.

test("every page carries a report only CSP that reports to /api/csp-report", async ({ request }) => {
  for (const path of ["/", "/pricing", "/app"]) {
    const headers = (await request.get(path)).headers();
    expect(headers["content-security-policy"], path).toBeUndefined();
    const policy = headers["content-security-policy-report-only"] ?? "";
    expect(policy, path).toContain("default-src 'self'");
    expect(policy, path).toContain("report-uri /api/csp-report");
    expect(policy, path).toContain("report-to csp-endpoint");
    expect(headers["reporting-endpoints"], path).toContain('csp-endpoint="');
  }
});

test("the CSP report endpoint accepts both report formats", async ({ request }) => {
  const legacy = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({
      "csp-report": { "document-uri": "http://localhost/", "blocked-uri": "inline", "violated-directive": "script-src" },
    }),
  });
  expect(legacy.status()).toBe(204);
  const modern = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json" },
    data: JSON.stringify([
      { type: "csp-violation", body: { documentURL: "http://localhost/", blockedURL: "eval", effectiveDirective: "script-src" } },
    ]),
  });
  expect(modern.status()).toBe(204);
  const wrongType = await request.post("/api/csp-report", { headers: { "content-type": "text/plain" }, data: "hi" });
  expect(wrongType.status()).toBe(415);
});

test("the stale job sweep refuses every caller while CRON_SECRET is unset", async ({ request }) => {
  const response = await request.post("/api/cron/stale-jobs", { headers: { authorization: "Bearer guess" } });
  expect(response.status()).toBe(503);
});
