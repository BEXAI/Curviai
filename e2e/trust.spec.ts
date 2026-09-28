import { expect, test } from "@playwright/test";

// Trust features in demo mode (no env vars): the data card in settings, the
// export download, the closed purge cron route and the account deleted page.

test("settings shows the data card with export, retention and a closed delete in demo mode", async ({ page }) => {
  await page.goto("/app/settings");
  const card = page.getByTestId("your-data");
  await expect(card).toBeVisible();
  await expect(card.getByText("How long we keep your uploads")).toBeVisible();
  await expect(card.getByText(/30 days old/)).toBeVisible();
  await expect(page.getByTestId("export-data")).toHaveAttribute("href", "/api/account/export");
  await expect(page.getByTestId("delete-account-unavailable")).toHaveText("Demo mode has no account to delete.");
});

test("the export link downloads a JSON file", async ({ page }) => {
  await page.goto("/app/settings");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-data").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^curvi-export-\d{4}-\d{2}-\d{2}\.json$/);
});

test("export api answers JSON with the export format", async ({ request }) => {
  const response = await request.get("/api/account/export");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { format: string };
  expect(body.format).toBe("curvi-export-v1");
});

test("the purge cron route stays closed without CRON_SECRET", async ({ request }) => {
  const response = await request.post("/api/cron/purge-source-media", { headers: { "x-cron-secret": "guess" } });
  expect(response.status()).toBe(503);
});

test("account deleted page renders", async ({ page }) => {
  await page.goto("/account-deleted?signin=pending");
  await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
  await expect(page.getByTestId("signin-pending")).toBeVisible();
});
