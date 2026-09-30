import { expect, test, type Page } from "@playwright/test";

// The preflight at upload and the product chooser (docs/phases/PHASE_14.md
// workstream 4 and item 3.2), in demo mode: the demo preflight simulates a
// photo with two products for keys with "several" in them, and a screenshot
// for keys with "screenshot".

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

async function uploadAs(page: Page, name: string, note?: string) {
  await page.route("**/api/uploads/sign", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://r2.e2e.invalid/upload", key: `ws/${DEMO_WORKSPACE_ID}/src/${name}` }),
    }),
  );
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  await page.route("https://r2.e2e.invalid/upload", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, body: "" }),
  );
  await page.goto("/app/new");
  if (note) {
    await page.getByLabel("Anything we should know").fill(note);
  }
  await page.getByLabel("Upload a product photo").setInputFiles({
    name: `${name}.png`,
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible();
}

test("a ready photo says what was found and which channels it is ready for", async ({ page }) => {
  await uploadAs(page, "e2e-watch");
  await expect(page.getByTestId("preflight-ready")).toContainText("Found: your product. Ready for Amazon");
  await expect(page.getByTestId("create-pack")).toBeEnabled();
});

test("the chooser asks which product, and the tapped box goes with the pack", async ({ page }) => {
  await uploadAs(page, "e2e-several");
  const chooser = page.getByTestId("product-chooser");
  await expect(chooser).toContainText("We found 2 products in this photo");
  const items = page.getByTestId("chooser-item");
  await expect(items).toHaveCount(2);
  const create = page.getByTestId("create-pack");
  await expect(create).toBeDisabled();
  await expect(page.getByTestId("preflight-block")).toHaveText("Tap the product this pack is for.");

  await items.nth(1).click();
  await expect(items.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("preflight-ready")).toContainText("Found: white sneakers.");
  await expect(create).toBeEnabled();

  const request = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await create.click();
  const body = (await request).postDataJSON() as { uploads: Array<{ key: string; targetBox?: unknown }> };
  expect(body.uploads[0].key).toBe(`ws/${DEMO_WORKSPACE_ID}/src/e2e-several`);
  expect(body.uploads[0].targetBox).toEqual({ x: 0.5, y: 0.45, width: 0.44, height: 0.3 });
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
});

test("the note preselects the product it names", async ({ page }) => {
  await uploadAs(page, "e2e-several-noted", "Just the watch please");
  const items = page.getByTestId("chooser-item");
  await expect(items.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("create-pack")).toBeEnabled();
});

test("a photo with a blocking problem cannot start a pack", async ({ page }) => {
  let posted = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/jobs") && r.method() === "POST") posted = true;
  });
  await uploadAs(page, "e2e-screenshot");
  await expect(page.getByTestId("preflight-problem")).toContainText("This looks like a screenshot");
  const create = page.getByTestId("create-pack");
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(create).toBeEnabled();
  expect(posted).toBe(false);
});

// docs/phases/PHASE_16.md workstream 4: the question step, beside the note.
// The demo preflight asks its questions for keys with "questions" in them.
test("the question step asks which product with labeled options, and the answers go with the pack", async ({ page }) => {
  await uploadAs(page, "e2e-questions");
  const step = page.getByTestId("question-step");
  await expect(step).toContainText("Which product is this pack for?");
  await expect(step).toContainText("Where will you sell?");
  // The target question stands in for the chooser while the step is shown.
  await expect(page.getByTestId("product-chooser")).toHaveCount(0);
  const targets = page.getByTestId("question-target-option");
  await expect(targets).toHaveText(["silver watch", "white sneakers", "Both"]);

  await targets.nth(1).click();
  await expect(targets.nth(1)).toHaveAttribute("aria-pressed", "true");
  const create = page.getByTestId("create-pack");
  await expect(create).toBeEnabled();

  const request = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await create.click();
  const body = (await request).postDataJSON() as {
    uploads: Array<{ key: string; targetBox?: unknown }>;
    sellerAnswers?: { key: string; picks: Record<string, string> };
  };
  const key = `ws/${DEMO_WORKSPACE_ID}/src/e2e-questions`;
  expect(body.uploads[0].targetBox).toEqual({ x: 0.5, y: 0.45, width: 0.44, height: 0.3 });
  expect(body.sellerAnswers).toEqual({ key, picks: { target: "item:2" } });
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
});

test("Skip, use my note hides the step and brings the chooser back, and Both needs no tap", async ({ page }) => {
  await uploadAs(page, "e2e-questions-skip");
  await page.getByTestId("question-skip").click();
  await expect(page.getByTestId("question-step")).toHaveCount(0);
  await expect(page.getByTestId("product-chooser")).toBeVisible();
  await page.getByTestId("question-reopen").click();
  await page.getByTestId("question-target-option").filter({ hasText: "Both" }).click();
  await expect(page.getByTestId("create-pack")).toBeEnabled();
  // Skipping after Both drops the pick, so the chooser asks again.
  await page.getByTestId("question-skip").click();
  await expect(page.getByTestId("product-chooser")).toBeVisible();
  await expect(page.getByTestId("create-pack")).toBeDisabled();
});
