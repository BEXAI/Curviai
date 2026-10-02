import { expect, test } from "@playwright/test";

test("mobile app menu supports keyboard navigation and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.focus(); await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#app-navigation-menu").getByRole("link", { name: "Dashboard", exact: true })).toBeFocused();
  for (const name of ["Connected apps", "Help", "Contact us"]) await expect(page.locator("#app-navigation-menu").getByRole("link", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(menu).toBeFocused(); await expect(menu).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.locator("#app-navigation-menu").getByRole("link", { name: "Billing", exact: true })).toBeFocused();
});

test("support prefills a pack and honestly acknowledges demo mode", async ({ page }) => {
  await page.goto("/support?topic=pack&job=10000000-0000-4000-8000-000000000001");
  await expect(page.getByLabel("What do you need help with?")).toHaveValue("pack");
  await page.getByLabel("Your email", { exact: true }).fill("seller@example.com");
  await page.getByLabel("Tell us what happened").fill("The main image needs help with its background.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Demo mode" })).toContainText("no email was sent");
});

test("help filters titles, renders article data and excludes gated pages", async ({ page, request }) => {
  await page.goto("/help"); await page.getByRole("searchbox", { name: "Find an article" }).fill("Shopify");
  await page.getByRole("link", { name: "Upload your images to Shopify", exact: true }).click();
  await expect(page).toHaveURL(/\/help\/upload-images-to-shopify$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Upload your images to Shopify");
  expect(await page.locator('script[type="application/ld+json"]').allTextContents()).toContainEqual(expect.stringContaining('"@type":"Article"'));
  expect((await request.get("/help/invite-your-team")).status()).toBe(404);
  expect((await request.get("/help/refunds-and-money-back-promise")).status()).toBe(404);
  const map = await (await request.get("/sitemap.xml")).text(); expect(map).toContain("/help/upload-images-to-shopify"); expect(map).not.toContain("/help/invite-your-team");
});

test("status and changelog have customer language and footer links", async ({ page }) => {
  await page.goto("/status");
  for (const name of ["Making packs", "Lifestyle scenes", "Downloads", "Sign in and billing"]) await expect(page.locator("dt").filter({ hasText: name })).toBeVisible();
  expect(await page.locator("main").innerText()).not.toMatch(/fal|replicate|supabase|resend|provider_quota/i);
  await page.locator("footer").getByRole("link", { name: "Changelog", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Changelog" })).toBeVisible();
});
