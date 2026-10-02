import { expect, test } from "@playwright/test";

// P18-16 in demo mode: the owner turns on the measured checks for a share
// page, and the public page shows each image's rows and the caption on a
// composited scene. Demo packs are drawn, so the rows list the checks with
// nothing measured, and the page says so.

test("a share with proof on shows the measured checks and the scene caption", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });

  const panel = page.getByTestId("share-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByText("The whole pack").click();
  const proof = panel.getByTestId("share-proof");
  await expect(proof).not.toBeChecked();
  await proof.check();
  await panel.getByTestId("share-publish").click();
  await expect(panel.getByTestId("share-published")).toBeVisible();
  const path = await panel.getByTestId("share-link").innerText();

  await page.goto(path);
  const proofPanel = page.getByTestId("share-proof-panel");
  await expect(proofPanel).toBeVisible();
  await expect(proofPanel.getByRole("heading", { name: "Measured on every file" })).toBeVisible();
  await expect(proofPanel.getByTestId("proof-row").first()).toBeVisible();
  await expect(proofPanel.getByTestId("proof-caption").first()).toHaveText("Scene made with AI around the real product");
  // No object key or file name reaches the public page.
  await expect(proofPanel).not.toContainText("ws/");
});

test("a share published without proof shows no proof panel", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15_000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45_000 });

  const panel = page.getByTestId("share-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByTestId("share-publish").click();
  await expect(panel.getByTestId("share-published")).toBeVisible();
  const path = await panel.getByTestId("share-link").innerText();

  await page.goto(path);
  await expect(page.getByTestId("share-title")).toBeVisible();
  await expect(page.getByTestId("share-proof-panel")).toHaveCount(0);
});
