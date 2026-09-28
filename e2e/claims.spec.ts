import { expect, test } from "@playwright/test";

// Truthful surface checks (Phase 10, package P1). Features that do not run
// in production carry a Coming soon label, drawings are labeled as
// illustrations, and retired claims stay gone. These run in demo mode.

test("home labels features on the way and drawings as illustrations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("feature-freshCreativeDrop").getByTestId("coming-soon")).toBeVisible();
  await expect(page.getByTestId("feature-directPublishing").getByTestId("coming-soon")).toBeVisible();
  await expect(page.getByTestId("feature-fidelity").getByTestId("coming-soon")).toHaveCount(0);
  await expect(page.getByTestId("illustration-label").first()).toBeVisible();
  const body = page.locator("body");
  await expect(body).not.toContainText("Curvi output");
  await expect(body).not.toContainText("40 to 60");
  await expect(body).not.toContainText("Publish straight to Shopify");
  await expect(page.getByTestId("home-pack-size")).toContainText(/about \d+ credits/);
  await expect(page.getByTestId("hero-upload-box")).toContainText("Nothing is uploaded from this page");
});

test("help marks the Fresh Creative Drop as coming soon", async ({ page }) => {
  await page.goto("/help");
  await expect(page.locator("#what-is-the-fresh-creative-drop").getByTestId("coming-soon")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("text policy");
  await expect(page.locator("body")).not.toContainText("40 to 60");
});

test("gallery cases are labeled illustrations", async ({ page }) => {
  await page.goto("/gallery");
  await expect(page.getByTestId("illustration-label").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Curvi output");
});

test("category page lists video under coming soon", async ({ page }) => {
  await page.goto("/for/beauty");
  await expect(page.getByTestId("coming-soon").first()).toBeVisible();
  await expect(page.getByTestId("illustration-label")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("share page");
});

test("share page says share pages are coming soon", async ({ page }) => {
  await page.goto("/s/example");
  await expect(page.getByTestId("coming-soon").first()).toBeVisible();
  await expect(page.getByTestId("illustration-label")).toBeVisible();
});

test("dashboard never promises a product URL import", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByTestId("credit-balance")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("product URL");
  await expect(page.getByTestId("credit-balance")).not.toContainText("40 to 60");
});
