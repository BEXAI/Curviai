import { expect, test } from "@playwright/test";

test("home renders headline and nav", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Shot once. Ready everywhere." }),
  ).toBeVisible();
  const header = page.locator("header");
  await expect(header.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Free tools" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Gallery" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Help" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Start free" })).toBeVisible();
  // Signed out visitors never see the signed in shortcut.
  await expect(header.getByRole("link", { name: "Open app" })).toHaveCount(0);
});

test("pricing shows all four tier prices", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByTestId("price-starter")).toHaveText("$29");
  await expect(page.getByTestId("price-growth")).toHaveText("$79");
  await expect(page.getByTestId("price-pro")).toHaveText("$149");
  await expect(page.getByTestId("price-agency")).toHaveText("$349");
});

test("main image checker renders the file input", async ({ page }) => {
  await page.goto("/tools/main-image-checker");
  await expect(page.locator('input[type="file"]')).toBeAttached();
});

test("amazon main channel page shows the real rules", async ({ page }) => {
  await page.goto("/channels/amazon-main/image-requirements");
  await expect(page.locator("body")).toContainText("1600");
  await expect(page.locator("body")).toContainText("pure white", { ignoreCase: true });
});

test("sitemap.xml returns 200", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
});
