import { expect, test } from "@playwright/test";

// Phase 10 package P3. Demo mode: no env vars, so these check the parts that
// do not need Supabase: security headers, id validation and the job page.

for (const path of ["/", "/app", "/pricing"]) {
  test(`security headers are set on ${path}`, async ({ request }) => {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });
}

test("a non uuid job id is a 404 on every job route", async ({ request }) => {
  for (const path of ["/api/jobs/abc", "/api/jobs/abc/files", "/api/jobs/abc/pack"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("a non uuid product id is a 400 when creating a job", async ({ request }) => {
  const response = await request.post("/api/jobs", {
    headers: { "Idempotency-Key": `e2e-security-${Date.now()}` },
    data: { productId: "abc", channels: ["amazon.main"], mode: "listing" },
  });
  expect(response.status()).toBe(400);
});

test("the job page shows not found for a non uuid id", async ({ page }) => {
  const response = await page.goto("/app/jobs/not-a-job");
  expect(response?.status()).toBe(404);
});
