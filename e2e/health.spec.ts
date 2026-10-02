import { expect, test } from "@playwright/test";

// Render's healthCheckPath and the post deploy smoke test hit this endpoint.
// e2e runs in demo mode (no env), where the database checks are skipped.

test("health endpoint returns ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"] ?? "").toContain("no-store");
  const body = await res.json();
  expect(body.ok).toBe(true);
  // P20-15: the second uptime monitor matches "status":"ok" in the body.
  expect(body.status).toBe("ok");
  expect(body.degradedBy).toEqual([]);
  expect(await res.text()).toContain('"status":"ok"');
  expect(body.mode).toBe("demo");
  expect(body.checks.database).toBe("skipped");
  expect(typeof body.migrations.expected).toBe("string");
});
