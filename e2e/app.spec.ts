import { expect, test } from "@playwright/test";

// These specs run against demo mode: no env vars, in memory services and a
// simulated pack that advances one state per poll.

test("dashboard renders credits and the first session empty state or products", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByTestId("credit-balance")).toBeVisible();
  await expect(page.getByTestId("credit-balance")).toContainText(/\d/);
  const firstSession = page.getByTestId("first-session");
  const productsGrid = page.getByTestId("products-grid");
  await expect(firstSession.or(productsGrid).first()).toBeVisible();
});

test("new pack page shows channel groups and a credit estimate", async ({ page }) => {
  await page.goto("/app/new");
  await expect(page.getByRole("heading", { name: "Marketplaces" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Social and video" })).toBeVisible();
  await expect(page.getByText("Listing Mode")).toBeVisible();
  await expect(page.getByText("Concept Mode")).toBeVisible();
  const estimate = page.getByTestId("credit-estimate");
  await expect(estimate).toBeVisible();
  const value = Number(await estimate.innerText());
  expect(value).toBeGreaterThan(0);
});

test("submitting a demo job navigates to the job page and progress advances", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });

  const status = page.getByTestId("job-status");
  await expect(status).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("shot-card").first()).toBeVisible();

  const initial = (await status.innerText()).trim();
  await expect
    .poll(async () => (await status.innerText()).trim(), {
      timeout: 30000,
      message: "job status should advance beyond its first observed state",
    })
    .not.toBe(initial);

  await expect(status).toHaveText("done", { timeout: 45000 });
  await expect(page.getByTestId("compliance-badge").first()).toBeVisible();

  // The delivery surface: channel tabs with named files and previews.
  await expect(page.getByTestId("pack-downloads")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pack-file").first()).toBeVisible();
});

test("health endpoint returns provider and breaker state json", async ({ request }) => {
  const response = await request.get("/api/health/providers");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.mode).toBe("demo");
  expect(Array.isArray(body.providers)).toBe(true);
  expect(body.providers.length).toBeGreaterThan(0);
  for (const provider of body.providers) {
    expect(provider.configured).toBe(false);
    expect(provider.breaker).toBe("closed");
  }
});

test("jobs api requires an Idempotency-Key header", async ({ request }) => {
  const response = await request.post("/api/jobs", {
    data: { productId: "anything", channels: ["amazon.main"], mode: "listing" },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(String(body.error)).toContain("Idempotency-Key");
});

test("jobs api rejects unknown channels", async ({ request }) => {
  const response = await request.post("/api/jobs", {
    headers: { "Idempotency-Key": `e2e-${Date.now()}` },
    data: { productId: "anything", channels: ["not.a.channel"], mode: "listing" },
  });
  expect(response.status()).toBe(400);
});

test("upload sign validates and reports the R2 setup notice in demo mode", async ({ request }) => {
  const tooBig = await request.post("/api/uploads/sign", {
    data: { kind: "image", contentType: "image/jpeg", bytes: 26 * 1024 * 1024 },
  });
  expect(tooBig.status()).toBe(400);

  const valid = await request.post("/api/uploads/sign", {
    data: { kind: "image", contentType: "image/jpeg", bytes: 1024 },
  });
  expect(valid.status()).toBe(503);
  const body = await valid.json();
  expect(String(body.notice)).toContain("R2");
});
