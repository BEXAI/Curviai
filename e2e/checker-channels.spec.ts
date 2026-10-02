import { expect, test, type Page } from "@playwright/test";

// P18-10, demo mode: the main image checker's channel picker. The numbers
// below are the registry's amazon.main and google.merchant.main fill ranges.

/** A 200 by 200 PNG drawn in the browser: white, with a product square
 * filling 80 percent of the frame, inside Google's fill range and under
 * Amazon's. */
async function eightyPercentPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = "#2a5aa0";
    ctx.fillRect(20, 20, 160, 160);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("picking Google applies the Google fill range to the same image", async ({ page }) => {
  await page.goto("/tools/main-image-checker");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Amazon Main Image Checker");
  const png = await eightyPercentPng(page);
  await page.getByLabel("Choose an image to check").setInputFiles({ name: "product.png", mimeType: "image/png", buffer: png });

  await expect(page.getByText("Fail. Product fills 85 to 90 percent of the frame")).toBeVisible();
  // One measured value sits above the email gate.
  await expect(page.getByTestId("checker-fill-measured")).toContainText("Measured fill 80.0 percent");
  await expect(page.getByTestId("checker-measurements")).toHaveCount(0);
  const fix = page.getByTestId("checker-fix");
  await expect(fix).toHaveText("Fix this image free");
  await expect(fix).toHaveAttribute("href", /source=tool_checker_amazon/);

  await page.getByLabel("Which marketplace?").selectOption("google");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Google Merchant Main Image Checker");
  await expect(page.getByText("Pass. Product fills 75 to 90 percent of the frame")).toBeVisible();
  await expect(page.getByText("Pass. Background at the edges is white or transparent")).toBeVisible();
  await expect(page).toHaveURL(/[?&]channel=google/);
  await expect(page.getByTestId("checker-rules-link")).toHaveAttribute(
    "href",
    "/channels/google-merchant-main/image-requirements",
  );
});

test("?channel= presets the checker and an unknown value falls back to Amazon", async ({ page }) => {
  await page.goto("/tools/main-image-checker?channel=google");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Google Merchant Main Image Checker");
  await expect(page.getByLabel("Which marketplace?")).toHaveValue("google");
  await expect(page.getByTestId("checker-intro")).toContainText("75 to 90 percent");

  await page.goto("/tools/main-image-checker?channel=nowhere");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Amazon Main Image Checker");
});

test("a main spec's requirements page opens the checker with its channel", async ({ page }) => {
  await page.goto("/channels/google-merchant-main/image-requirements");
  const block = page.getByTestId("channel-checker");
  await expect(block).toContainText("Check your main image against these rules, free, in your browser.");
  await block.getByTestId("channel-checker-link").click();
  await expect(page).toHaveURL(/\/tools\/main-image-checker\?channel=google$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Google Merchant Main Image Checker");
});
