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

test("the example share page is labeled an illustration", async ({ page }) => {
  await page.goto("/s/example");
  await expect(page.getByTestId("share-title")).toBeVisible();
  await expect(page.getByTestId("illustration-label")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Curvi output");
});

test("dashboard never promises a product URL import", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByTestId("credit-balance")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("product URL");
  await expect(page.getByTestId("credit-balance")).not.toContainText("40 to 60");
});

test("channel pages label files Curvi does not make yet", async ({ page }) => {
  // amazon.aplus.premium_full has no planner support, so its page keeps the
  // rules but says the files are coming soon.
  await page.goto("/channels/amazon-aplus-premium-full/image-requirements");
  await expect(page.getByTestId("coming-soon").first()).toBeVisible();
  await expect(page.getByTestId("channel-intro")).toContainText("coming soon");
  await expect(page.getByTestId("channel-cta")).toContainText("coming soon");
  await expect(page.locator("body")).not.toContainText("Curvi builds");
  await expect(page.locator("body")).not.toContainText("passes them the first time");
});

test("channel pages for files a pack makes carry no coming soon label", async ({ page }) => {
  await page.goto("/channels/amazon-main/image-requirements");
  await expect(page.getByTestId("coming-soon")).toHaveCount(0);
  await expect(page.getByTestId("channel-intro")).toContainText("Curvi builds");
  await expect(page.getByTestId("channel-cta")).toContainText("Built to this spec");
});

test("free tool pages never sell video", async ({ page }) => {
  for (const path of ["/tools/main-image-checker", "/tools/white-background-fixer", "/tools/marketplace-resizer"]) {
    await page.goto(path);
    await expect(page.getByTestId("tool-pack-cta")).toBeVisible();
    await expect(page.getByTestId("tool-pack-cta")).not.toContainText(/video/i);
  }
});

test("signup states the free grant and promises no share page", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByTestId("signup-lead")).toContainText(/Start free with \d+ credits/);
  await expect(page.locator("body")).not.toContainText("share page");
});

test("brand kit page says which parts of the kit reach packs", async ({ page }) => {
  await page.goto("/app/brand");
  await expect(page.getByTestId("brand-kit-intro")).toContainText("brand color");
  await expect(page.getByTestId("brand-kit-intro")).toContainText("fonts and logo");
  await expect(page.getByTestId("brand-kit-intro")).not.toContainText("coming soon");
  await expect(page.locator("body")).not.toContainText("Sets the default look");
});
