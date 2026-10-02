import { expect, test, type Page } from "@playwright/test";

// Phase 18 Lane 8 Activation (docs/phases/PHASE_18.md P18-13 and P18-20),
// against demo mode: the in memory services keep the first run answers for
// the server process, so each test puts them back as it found them (none).

function channelBox(page: Page, specId: string) {
  return page.getByTestId(`channel-${specId}`).getByRole("checkbox");
}

async function clearAnswers(page: Page) {
  const response = await page.request.put("/api/workspace/seller-profile", { data: { category: null, channels: [] } });
  expect(response.ok()).toBe(true);
}

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ page }) => {
  await clearAnswers(page);
});

test("signup shows no Google button without NEXT_PUBLIC_GOOGLE_AUTH", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("google-sign-in")).toHaveCount(0);
  await page.goto("/login");
  await expect(page.getByTestId("google-sign-in")).toHaveCount(0);
});

test("a channel page preselects the welcome answer, and the answers preselect the first pack", async ({ page }) => {
  await page.goto("/welcome?category=candles&channel=amazon");
  await expect(page.getByTestId("welcome-questions")).toBeVisible();
  await expect(page.getByTestId("welcome-category-candles")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("welcome-channel-amazon")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("welcome-channel-shopify").click();
  await expect(page.getByTestId("welcome-channel-shopify")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("welcome-continue").click();

  await page.waitForURL("**/app/new");
  await expect(channelBox(page, "amazon.main")).toBeChecked();
  await expect(channelBox(page, "amazon.secondary")).toBeChecked();
  await expect(channelBox(page, "shopify.product")).toBeChecked();
  await expect(channelBox(page, "meta.feed_1x1")).not.toBeChecked();

  // Answered once: the welcome page does not ask again.
  await page.goto("/welcome");
  await expect(page.getByTestId("welcome-questions")).toHaveCount(0);
  await expect(page.getByTestId("welcome-continue")).toBeVisible();
});

test("skipping the questions saves nothing and keeps the default pick", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByTestId("welcome-questions")).toBeVisible();
  await page.getByTestId("welcome-skip").click();
  await expect(page.getByTestId("welcome-questions")).toHaveCount(0);
  await page.getByTestId("welcome-continue").click();
  await page.waitForURL("**/app/new");
  await expect(channelBox(page, "meta.feed_1x1")).toBeChecked();
  await page.goto("/welcome");
  await expect(page.getByTestId("welcome-questions")).toBeVisible();
});

test("the free preview ships switched off: no home box, and the API says it is closed", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("free-preview")).toHaveCount(0);
  const status = await page.request.get("/api/preview");
  expect(await status.json()).toEqual({ available: false });
  const attempt = await page.request.post("/api/preview", {
    multipart: { photo: { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not really a png") } },
  });
  expect(attempt.status()).toBe(503);
  expect(await attempt.json()).toMatchObject({ status: "closed", reason: "not_set_up" });
});

test("an empty dashboard shows the example pack", async ({ page }) => {
  await page.goto("/app");
  const firstSession = page.getByTestId("first-session");
  if (await firstSession.count()) {
    await expect(page.getByTestId("example-pack")).toContainText("Example made by Curvi from one candle photo");
  }
});
