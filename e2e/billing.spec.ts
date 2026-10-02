import { expect, test } from "@playwright/test";

// Billing and pricing in demo mode: no Stripe keys, so the billing page shows
// the honest "not open yet" state and request buttons instead of checkout.

test("pricing CTAs carry the chosen plan and cadence to signup", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByTestId("cta-growth")).toHaveAttribute(
    "href",
    "/signup?plan=growth&cadence=monthly&source=pricing",
  );
  await page.getByRole("switch", { name: "Toggle annual billing" }).click();
  await expect(page.getByTestId("cta-growth")).toHaveAttribute(
    "href",
    "/signup?plan=growth&cadence=annual&source=pricing",
  );
  await expect(page.getByTestId("annual-savings")).toContainText("save up to");
});

test("pricing lists unbuilt features under On the way, never inside a card (P20-08)", async ({ page }) => {
  await page.goto("/pricing");
  const onTheWay = page.getByTestId("on-the-way");
  await expect(onTheWay).toContainText("Generative video, coming soon to Growth and up.");
  await expect(onTheWay).toContainText("Coming soon");
  await expect(page.getByTestId("tier-growth")).not.toContainText("Generative video");
  await expect(page.getByTestId("tier-agency")).toHaveCount(0);
  await expect(page.getByTestId("larger-plan")).toContainText("Need more than Pro? Email us and we will set up a larger plan.");
});

test("pricing shows the renewal terms beside every plan button (P20-07)", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByTestId("renewal-terms-growth")).toContainText("renews automatically every month at $79");
  await expect(page.getByTestId("renewal-terms-growth")).toContainText("If our price changes, we email you before it applies");
  await page.getByRole("switch", { name: "Toggle annual billing" }).click();
  await expect(page.getByTestId("renewal-terms-growth")).toContainText("renews automatically every year");
  await expect(page.getByTestId("renewal-terms-growth")).toContainText("days before each renewal");
});

test("billing shows the finish upgrading card for a plan intent", async ({ page }) => {
  await page.goto("/app/billing?checkout=growth&cadence=annual");
  const card = page.getByTestId("finish-upgrade");
  await expect(card).toContainText("Finish upgrading to Growth");
  await expect(card).toContainText("once a year");
  await expect(page.getByTestId("billing-not-open")).toBeVisible();
});

test("billing confirms a return from Stripe", async ({ page }) => {
  await page.goto("/app/billing?status=canceled");
  await expect(page.getByTestId("checkout-return")).toContainText("You were not charged");
  await page.goto("/app/billing?status=success&kind=topup");
  await expect(page.getByTestId("checkout-return")).toContainText("Payment received");
});

test("billing offers a monthly and annual toggle", async ({ page }) => {
  await page.goto("/app/billing");
  const toggle = page.getByTestId("cadence-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
