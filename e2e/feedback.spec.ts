import { expect, test } from "@playwright/test";

// P18-05 in demo mode: the pack feedback card appears on a finished pack,
// sends one answer with a consented quote, and does not show again.

test.beforeEach(async ({ page }) => {
  // The demo server is shared by every spec, so another test's pack can
  // finish here and raise its notice over the card's buttons: dismiss it
  // (the same handler as reveal.spec.ts and output-options.spec.ts).
  await page.addLocatorHandler(
    page.getByTestId("pack-ready-notice").first(),
    async () => {
      const dismiss = page.getByTestId("pack-ready-notice").getByRole("button", { name: "Dismiss" });
      while ((await dismiss.count()) > 0) await dismiss.first().click();
    },
    { noWaitAfter: true },
  );
});

test("the feedback card appears on a done pack, sends, and stays gone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });

  const card = page.getByTestId("feedback-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Would you use these files in a live listing?").first()).toBeVisible();
  await expect(card.getByTestId("feedback-send")).toBeDisabled();

  await card.getByTestId("feedback-usable-yes").check();
  await card.getByTestId("feedback-comment").fill("The label reads right in every scene.");
  await card.getByTestId("feedback-pay-maybe").check();
  await card.getByTestId("feedback-consent").check();
  await card.getByTestId("feedback-name").fill("Ana, Juniper Candles");
  await card.getByTestId("feedback-send").click();

  await expect(page.getByTestId("feedback-thanks")).toContainText("Thank you");
  await expect(page.getByTestId("feedback-card")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 30_000 });
  // The share panel loads from the same kind of status call; once it shows,
  // the card has had its answer too.
  await expect(page.getByTestId("share-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("feedback-card")).toHaveCount(0);
});

test("Not now hides the card in this browser", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });

  const card = page.getByTestId("feedback-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("feedback-dismiss").click();
  await expect(page.getByTestId("feedback-card")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("share-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("feedback-card")).toHaveCount(0);
});

test("an invalid feedback link shows a plain notice", async ({ page }) => {
  await page.goto("/feedback/not-a-real-token");
  await expect(page.getByTestId("feedback-link-notice")).toBeVisible();
  await expect(page.getByTestId("feedback-link-page")).toHaveCount(0);
});
