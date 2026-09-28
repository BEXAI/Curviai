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
  // Concept Mode stays hidden until it really renders (features.ts).
  await expect(page.getByText("Concept Mode")).toHaveCount(0);
  // A new photo starts a new product by default.
  await expect(page.getByLabel("Product", { exact: true })).toHaveValue("new");
  const estimate = page.getByTestId("credit-estimate");
  await expect(estimate).toBeVisible();
  const value = Number(await estimate.innerText());
  expect(value).toBeGreaterThan(0);
});

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

test("create pack waits for the photo upload, then submits it", async ({ page }) => {
  let releasePut: () => void = () => undefined;
  const putDone = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  await page.route("**/api/uploads/sign", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://r2.e2e.invalid/upload", key: `ws/${DEMO_WORKSPACE_ID}/src/e2e-photo` }),
    }),
  );
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  await page.route("https://r2.e2e.invalid/upload", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    await putDone;
    await route.fulfill({ status: 200, headers: cors, body: "" });
  });
  const captured: { body: { uploads?: Array<{ key: string }> } | null } = { body: null };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/jobs") && request.method() === "POST") {
      captured.body = request.postDataJSON();
    }
  });

  await page.goto("/app/new");
  await page.getByLabel("Upload a product photo").setInputFiles({
    name: "mug.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });

  const create = page.getByTestId("create-pack");
  await expect(create).toHaveText("Uploading photo");
  await expect(create).toBeDisabled();
  releasePut();
  await expect(page.getByTestId("upload-done")).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(create).toHaveText("Create pack");

  await create.click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  expect(captured.body?.uploads?.[0]?.key).toBe(`ws/${DEMO_WORKSPACE_ID}/src/e2e-photo`);
});

test("a retry after a lost response reuses the Idempotency-Key and opens the same job", async ({ page }) => {
  const keys: string[] = [];
  let attempts = 0;
  const first: { jobId: string | null } = { jobId: null };
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    attempts += 1;
    if (attempts === 1) {
      // The server creates the job, but the response never reaches the page.
      const response = await route.fetch();
      first.jobId = ((await response.json()) as { job: { id: string } }).job.id;
      return route.abort("connectionreset");
    }
    return route.continue();
  });

  await page.goto("/app/new");
  const create = page.getByTestId("create-pack");
  await create.click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be started" })).toBeVisible();
  await create.click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });

  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(first.jobId).toBeTruthy();
  expect(page.url()).toContain(`/app/jobs/${first.jobId}`);
});

test("the board stops polling and says so when the server keeps failing", async ({ page }) => {
  await page.clock.install();
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  const jobPath = new URL(page.url()).pathname.replace("/app/jobs/", "/api/jobs/");

  let polls = 0;
  await page.route(`**${jobPath}`, (route) => {
    polls += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  });
  await page.reload();
  // Each poll waits on a real request, so advance the fake clock one backoff
  // step at a time until the board gives up.
  await expect(async () => {
    await page.clock.runFor(31_000);
    await expect(page.getByTestId("job-poll-error")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId("job-poll-error")).toContainText("We lost touch with the server");
  const settled = polls;
  expect(settled).toBeGreaterThanOrEqual(5);
  await page.clock.runFor(300_000);
  await page.waitForTimeout(500);
  expect(polls).toBe(settled);

  // Try again resumes polling.
  await page.unroute(`**${jobPath}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("job-status")).toBeVisible();
});

test("the board asks to sign in again when the session ended", async ({ page }) => {
  await page.route("**/api/jobs/00000000-0000-4000-8000-00000000e401", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Sign in" }) }),
  );
  await page.goto("/app/jobs/00000000-0000-4000-8000-00000000e401");
  await expect(page.getByTestId("job-poll-error")).toContainText("Your session ended");
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
    "href",
    /\/login\?next=%2Fapp%2Fjobs%2F00000000-0000-4000-8000-00000000e401/,
  );
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

  await expect(status).toHaveText("Done", { timeout: 45000 });
  await expect(page.getByTestId("compliance-badge").first()).toBeVisible();
  await expect(page.getByTestId("pack-summary")).toContainText("credits charged");
  await expect(page.getByRole("link", { name: "New pack for this product" })).toBeVisible();

  // The delivery surface: channel tabs with named files and previews.
  await expect(page.getByTestId("pack-downloads")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pack-file").first()).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("a job id that is not a uuid shows the not found page", async ({ page }) => {
  const response = await page.goto("/app/jobs/not-a-job");
  expect(response?.status()).toBe(404);
});

test("provider key probe is hidden without the cron secret", async ({ request }) => {
  // 404 while CRON_SECRET is unset, 401 when it is set but not sent.
  const response = await request.get("/api/health/providers");
  expect([401, 404]).toContain(response.status());
  expect(await response.text()).not.toContain("providers");
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

test("upload sign validates and says uploads are off in demo mode", async ({ request }) => {
  const tooBig = await request.post("/api/uploads/sign", {
    data: { kind: "image", contentType: "image/jpeg", bytes: 26 * 1024 * 1024 },
  });
  expect(tooBig.status()).toBe(400);

  const valid = await request.post("/api/uploads/sign", {
    data: { kind: "image", contentType: "image/jpeg", bytes: 1024 },
  });
  expect(valid.status()).toBe(503);
  const body = await valid.json();
  expect(body.reason).toBe("uploads_not_configured");
  expect(String(body.error)).toContain("demo server");
});

test("state changing api routes refuse a post from another site", async ({ request }) => {
  const response = await request.post("/api/products", {
    headers: { Origin: "https://evil.example" },
    data: { title: "Cross site", mode: "listing" },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).reason).toBe("cross_site");
});
