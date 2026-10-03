import { expect, test } from "@playwright/test";

// docs/phases/PHASE_20.md P20-23 in demo mode (no env vars): the terms,
// privacy and subprocessors pages read lib/legal, and the footer links the
// subprocessors page.

test("the terms carry every section, the support line and the credit terms", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of service" })).toBeVisible();
  for (const name of [
    "Who we are",
    "Plans, renewal and cancellation",
    "Credits",
    "Refunds",
    "AI outputs",
    "Governing law",
  ]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("terms-who-we-are")).toContainText("We reply within two business days.");
  await expect(page.getByTestId("terms-who-we-are")).toContainText(
    "Curvi is run by AIManagement Inc., 131 Continental Drive, Suite 305, Newark New Castle, DE 19713.",
  );
  await expect(page.getByTestId("terms-who-we-are").getByTestId("legal-pending")).toHaveCount(0);
  await expect(page.getByTestId("terms-governing-law").getByTestId("legal-pending")).toBeVisible();
  await expect(page.getByTestId("terms-credits")).toContainText("Credits you do not use stay in your balance");
  await expect(page.locator("body")).not.toContainText("rollover policy");
});

test("the privacy policy shows retention as a table with the purge window", async ({ page }) => {
  await page.goto("/privacy");
  const table = page.getByTestId("privacy-retention");
  await expect(table.getByRole("table")).toBeVisible();
  await expect(page.getByTestId("retention-source_uploads")).toContainText("30 days old");
  await expect(page.getByTestId("retention-pack_files")).toContainText("while your account is open");
  await expect(page.locator("body")).not.toContainText("thirty days");
  await expect(page.getByTestId("privacy-contact")).toContainText(
    "Curvi is run by AIManagement Inc., 131 Continental Drive, Suite 305, Newark New Castle, DE 19713.",
  );
  await expect(page.getByTestId("privacy-contact").getByTestId("legal-pending")).toHaveCount(0);
  await page.getByTestId("privacy-processors").getByRole("link", { name: "subprocessors page" }).click();
  await expect(page).toHaveURL(/\/legal\/subprocessors$/);
});

test("the subprocessors page lists hosting and the database, and the footer links it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Subprocessors" }).click();
  await expect(page).toHaveURL(/\/legal\/subprocessors$/);
  await expect(page.getByRole("heading", { name: "Subprocessors", level: 1 })).toBeVisible();
  await expect(page.getByTestId("vendor-render")).toContainText("Hosts the website");
  await expect(page.getByTestId("vendor-supabase")).toContainText("Runs our database and sign in.");
  await expect(page.getByTestId("legal-last-updated")).toContainText("Last updated");
});

test("help and settings state the reply time and the upload window from lib/legal", async ({ page }) => {
  await page.goto("/help");
  await expect(page.locator("main")).toContainText("a person replies within two business days");
  await page.goto("/app/settings");
  const retention = page.getByTestId("upload-retention");
  await expect(retention).toContainText("30 days old");
  await expect(retention.getByRole("link", { name: "How long we keep everything" })).toHaveAttribute(
    "href",
    "/privacy#retention",
  );
});
