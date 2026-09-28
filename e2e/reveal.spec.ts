import { expect, test } from "@playwright/test";

// Before and after reveal and the in app pack ready notice, against demo
// mode: in memory services and a simulated pack that advances one state per
// poll of its job.

test("a finished pack shows the before and after with a share panel", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45000 });

  const reveal = page.getByTestId("pack-reveal");
  await expect(reveal).toBeVisible();
  await expect(reveal.getByRole("heading", { name: "Before and after" })).toBeVisible();
  await expect(page.getByTestId("reveal-slider")).toBeVisible();
  // Demo mode has no stored photo: the drawing is labeled as one.
  await expect(reveal.getByTestId("illustration-label")).toBeVisible();
  await expect(reveal.getByRole("slider", { name: "Compare before and after" })).toBeVisible();

  await reveal.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByTestId("reveal-side-by-side")).toBeVisible();
  await expect(page.getByTestId("reveal-side-by-side").getByRole("img")).toHaveCount(2);

  // Share: the link is the workspace only pack page until share pages go live.
  await expect(page.getByTestId("share-audience")).toContainText("people in your workspace");
  await page.getByTestId("copy-makeover-link").click();
  await expect(page.getByTestId("copy-makeover-link")).toHaveText("Link copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(page.url());

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-makeover").click()]);
  expect(download.suggestedFilename()).toMatch(/before-after-.+\.jpg$/);
  expect(await download.failure()).toBeNull();
});

test("a pack that finishes while the seller is elsewhere in the app raises a notice", async ({ page }) => {
  await page.clock.install();
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  const jobPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("job-status")).toBeVisible({ timeout: 15000 });

  // Leave for the dashboard with a client side navigation, as a seller would.
  await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Dashboard" }).click();
  await page.waitForURL(/\/app$/);

  // The demo server is shared by every spec, so packs other tests left
  // running can raise their own notices: pick this pack's by its link.
  const notice = page.getByTestId("pack-ready-notice").filter({ has: page.locator(`a[href="${jobPath}"]`) });
  await expect(async () => {
    await page.clock.runFor(5000);
    await expect(notice).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 45_000 });
  await expect(notice).toContainText("Your pack is ready");

  await notice.getByRole("link", { name: "View pack" }).click();
  await page.waitForURL(`**${jobPath}`);
  await expect(notice).toHaveCount(0);
});

test("the pack page itself raises no notice when its pack finishes on screen", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  const jobPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45000 });
  // Give the notice's poll loop a few cycles to (wrongly) fire.
  await page.waitForTimeout(6000);
  await expect(
    page.getByTestId("pack-ready-notice").filter({ has: page.locator(`a[href="${jobPath}"]`) }),
  ).toHaveCount(0);
});
