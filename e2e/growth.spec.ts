import { expect, test, type Page } from "@playwright/test";

// Growth (Phase 11, b2/growth), in demo mode: share pages and the gallery
// opt in, and the free tools' email gate with the transparency fix.

/** A 200 by 200 PNG drawn in the browser: a transparent frame around an
 * opaque product filling 88 percent of the frame. */
async function transparentProductPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 200, 200);
    ctx.fillStyle = "#2a5aa0";
    ctx.fillRect(12, 12, 176, 176);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("the checker reads transparency as white and gates the measurements behind an email", async ({ page }) => {
  await page.goto("/tools/main-image-checker");
  const png = await transparentProductPng(page);
  await page.getByLabel("Choose an image to check").setInputFiles({ name: "cutout.png", mimeType: "image/png", buffer: png });

  await expect(page.getByTestId("checker-report")).toBeVisible();
  await expect(page.getByTestId("checker-summary")).toBeVisible();
  // The free summary names each check; the measurements wait for an email.
  await expect(page.getByText("Pass. Product fills 85 to 90 percent of the frame")).toBeVisible();
  await expect(page.getByText("Pass. Background at the edges is pure white, RGB 255 255 255")).toBeVisible();
  await expect(page.getByTestId("checker-measurements")).toHaveCount(0);

  const gate = page.getByTestId("email-gate");
  await gate.getByLabel("Email").fill("not an email");
  await gate.getByRole("button", { name: "Show full results" }).click();
  await expect(gate.getByRole("alert")).toContainText("Enter a valid email address.");

  await gate.getByLabel("Email").fill("seller@example.com");
  await gate.getByRole("button", { name: "Show full results" }).click();
  const measurements = page.getByTestId("checker-measurements");
  await expect(measurements).toBeVisible();
  await expect(measurements).toContainText("Measured fill 88.0 percent");

  // The unlock is remembered for the other tools in this browser.
  await page.goto("/tools/white-background-fixer");
  await page.getByLabel("Choose an image to whiten").setInputFiles({ name: "cutout.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Download preview" })).toBeVisible();
});

test("the fixer keeps its download behind the email gate for a new visitor", async ({ page }) => {
  await page.goto("/tools/white-background-fixer");
  const png = await transparentProductPng(page);
  await page.getByLabel("Choose an image to whiten").setInputFiles({ name: "cutout.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("email-gate")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download preview" })).toHaveCount(0);
});

test("the leads endpoint refuses a bad email and accepts a good one", async ({ request }) => {
  const bad = await request.post("/api/leads", { data: { email: "nope", source: "gallery" } });
  expect(bad.status()).toBe(400);
  const good = await request.post("/api/leads", { data: { email: "e2e@example.com", source: "gallery" } });
  expect(good.status()).toBe(200);
});

test("an owner publishes a pack, lists it in the gallery and takes it down", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });

  const panel = page.getByTestId("share-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByText("The whole pack").click();
  await panel.getByTestId("share-gallery").check();
  await panel.getByTestId("share-publish").click();
  await expect(panel.getByTestId("share-published")).toBeVisible();
  const path = await panel.getByTestId("share-link").innerText();
  expect(path).toMatch(/^\/s\/[a-z2-9]{10}$/);
  const jobUrl = page.url();

  await page.goto(path);
  await expect(page.getByTestId("share-title")).toBeVisible();
  await expect(page.getByTestId("share-pack")).toBeVisible();
  // Demo packs are drawn, and the page says so.
  await expect(page.getByTestId("illustration-label").first()).toBeVisible();

  await page.goto("/gallery");
  await expect(page.getByTestId("customer-makeovers").locator(`a[href="${path}"]`)).toBeVisible();

  await page.goto(jobUrl);
  await expect(page.getByTestId("share-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("share-unpublish").click();
  await expect(page.getByTestId("share-published")).toHaveCount(0);

  const gone = await page.goto(path);
  expect(gone?.status()).toBe(404);
});
