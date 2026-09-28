import { expect, test } from "@playwright/test";

// Batch 2 retention flows in demo mode (no Stripe keys, in memory services):
// the cancel flow with save offers, the brand kit font and preset choices,
// and the readable compliance report with its PDF download.

test("cancel flow asks the reason, offers save options, and records a cancel without Stripe", async ({ page }) => {
  await page.goto("/app/billing");
  const section = page.getByTestId("cancel-section");
  await expect(section).toBeVisible();
  await page.getByTestId("cancel-open").click();

  const flow = page.getByTestId("cancel-flow");
  await expect(flow).toContainText("Why do you want to cancel?");
  await expect(page.getByTestId("cancel-continue")).toBeDisabled();
  await page.getByTestId("cancel-reason-too_expensive").check();
  await page.getByTestId("cancel-continue").click();

  // Too expensive leads with the discount, then the smaller plan, then a pause.
  await expect(flow).toContainText("Before you go");
  const offers = flow.locator("[data-testid^='cancel-offer-']");
  await expect(offers).toHaveCount(3);
  await expect(offers.first()).toHaveAttribute("data-testid", "cancel-offer-discount");
  await expect(page.getByTestId("cancel-offer-downgrade")).toContainText("Switch to Starter");
  await expect(page.getByTestId("cancel-offer-pause")).toContainText("Pause billing");

  await page.getByTestId("cancel-no-thanks").click();
  await expect(flow).toContainText("Cancel your Growth plan?");
  await page.getByTestId("cancel-confirm").click();
  await expect(page.getByTestId("cancel-result")).toContainText("nothing is charged or changed today");
});

test("cancel flow can end in a save offer", async ({ page }) => {
  await page.goto("/app/billing");
  await page.getByTestId("cancel-open").click();
  await page.getByTestId("cancel-reason-unused").check();
  await page.getByTestId("cancel-continue").click();
  const offers = page.getByTestId("cancel-flow").locator("[data-testid^='cancel-offer-']");
  await expect(offers.first()).toHaveAttribute("data-testid", "cancel-offer-pause");
  await page.getByTestId("cancel-offer-pause").getByRole("button").click();
  await expect(page.getByTestId("cancel-result")).toBeVisible();
});

test("brand kit offers the bundled fonts and an automatic style preset", async ({ page }) => {
  await page.goto("/app/brand");
  const heading = page.getByLabel("Heading font");
  await expect(heading.locator("option")).toContainText(["Inter (default)", "Montserrat", "Playfair Display", "Lora"]);
  await heading.selectOption("playfair_display");
  await expect(heading).toHaveValue("playfair_display");
  await expect(page.getByLabel("Style preset").locator("option").first()).toHaveText(
    "Automatic, matched to the product",
  );
});

test("a finished pack shows the readable compliance report and a PDF download", async ({ page, request }) => {
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 60000 });

  const report = page.getByTestId("compliance-report");
  await expect(report).toBeVisible({ timeout: 15000 });
  await expect(report).toContainText("Compliance report");
  await expect(report.getByTestId("compliance-file").first()).toBeVisible();
  await expect(report).toContainText("Image size");
  await expect(report).toContainText("Real packs show the measured values.");

  const href = await page.getByTestId("compliance-pdf").getAttribute("href");
  expect(href).toMatch(/\/api\/jobs\/[0-9a-f-]{36}\/compliance-report\.pdf$/);
  const pdf = await request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toContain("compliance-report.pdf");
  expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
});
