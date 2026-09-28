import { expect, test } from "@playwright/test";

// Paywall moments in demo mode: no Stripe keys, so every prompt explains that
// credits are limited during early access and links to billing, never to
// checkout.

test("the app header shows the credit balance and links to billing", async ({ page }) => {
  await page.goto("/app");
  const balance = page.getByTestId("header-credit-balance");
  await expect(balance).toBeVisible();
  await expect(balance).toHaveText(/^[\d,.]+ credits?$/);
  await expect(balance).toHaveAttribute("href", "/app/billing");
});

test("a pack the balance cannot cover opens the upgrade dialog instead of an error", async ({ page }) => {
  await page.route("**/api/jobs", (route) =>
    route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Not enough credits for this pack. Top up or pick fewer channels.",
        reason: "insufficient_credits",
      }),
    }),
  );
  await page.goto("/app/new");
  await page.getByTestId("create-pack").click();

  const dialog = page.getByTestId("out-of-credits-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Not enough credits for this pack" })).toBeVisible();
  await expect(dialog).toContainText("Not enough credits for this pack");
  await expect(dialog).toContainText("Credits are limited during early access");
  const link = dialog.getByRole("link", { name: "Open Billing" });
  await expect(link).toHaveAttribute("href", "/app/billing");
  await expect(dialog.locator('a[href*="checkout"]')).toHaveCount(0);
  // The raw server message is not shown as an error line.
  await expect(page.getByText("Top up or pick fewer channels.")).toHaveCount(0);

  await dialog.getByTestId("paywall-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("create-pack")).toBeEnabled();
});
