import { expect, test, type Page } from "@playwright/test";

// Seller inputs on the new pack form and the products library, in demo mode
// (no env vars, in memory services).

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

/** Signs every upload to a fake bucket that accepts it at once. */
async function fakeUploads(page: Page): Promise<void> {
  let n = 0;
  await page.route("**/api/uploads/sign", (route) => {
    n += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: `https://r2.e2e.invalid/upload/${n}`, key: `ws/${DEMO_WORKSPACE_ID}/src/e2e-${n}` }),
    });
  });
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  await page.route("https://r2.e2e.invalid/upload/**", (route) =>
    route.fulfill({ status: route.request().method() === "OPTIONS" ? 204 : 200, headers: cors, body: "" }),
  );
}

const png = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });

test("a pack sends photo roles and details, and the product shows up in the library", async ({ page }) => {
  await fakeUploads(page);
  const captured: { body: Record<string, unknown> | null } = { body: null };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/jobs") && request.method() === "POST") {
      captured.body = request.postDataJSON();
    }
  });

  await page.goto("/app/new");
  const title = `E2E kettle ${Date.now()}`;
  await page.getByLabel("Product name").fill(title);
  await page.getByLabel("Upload a product photo").setInputFiles([png("front.png"), png("box.png")]);
  await expect(page.getByTestId("photo-item")).toHaveCount(2);
  await expect(page.getByTestId("upload-done")).toHaveCount(2);
  const angles = page.getByTestId("photo-angle");
  await expect(angles.nth(0)).toHaveValue("front");
  await expect(angles.nth(1)).toHaveValue("back");
  await angles.nth(1).selectOption("in_the_box");

  const estimate = page.getByTestId("credit-estimate");
  const before = Number(await estimate.innerText());
  await page.getByLabel("SKU").fill("KETTLE-1");
  await page.getByLabel("What is in the box").fill("Kettle\nFilter");
  await page.getByLabel("How it compares").fill("Boils 1.7 l, most boil 1.2 l");
  await expect.poll(async () => Number(await estimate.innerText())).toBeGreaterThan(before);

  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  const body = captured.body as {
    uploads?: Array<{ key: string; angle?: string }>;
    sku?: string;
    boxContents?: string[];
    comparisonFacts?: string[];
  } | null;
  expect(body?.uploads?.map((u) => u.angle)).toEqual(["front", "in_the_box"]);
  expect(body?.sku).toBe("KETTLE-1");
  expect(body?.boxContents).toEqual(["Kettle", "Filter"]);
  expect(body?.comparisonFacts).toEqual(["Boils 1.7 l, most boil 1.2 l"]);

  await page.getByRole("link", { name: "Products", exact: true }).click();
  await page.waitForURL(/\/app\/products$/);
  const entry = page.getByTestId("product-entry").filter({ hasText: title });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("2 photos, SKU KETTLE-1");
  await expect(entry).toContainText("In the box: Kettle, Filter");
  await expect(entry.getByTestId("pack-history-row")).toHaveCount(1);
  await expect(entry.getByTestId("pack-history-row")).toContainText("Amazon");

  await entry.getByRole("link", { name: "New pack for this product" }).click();
  await page.waitForURL(/\/app\/new\?product=/);
  await expect(page.getByLabel("SKU")).toHaveValue("KETTLE-1");
  await expect(page.getByLabel("What is in the box")).toHaveValue("Kettle\nFilter");
});

test("the form explains a line too long to print before sending anything", async ({ page }) => {
  let posted = false;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/jobs") && request.method() === "POST") {
      posted = true;
    }
  });
  await page.goto("/app/new");
  await page.getByLabel("What is in the box").fill("A very long description of the thing in the box");
  await expect(page.getByTestId("seller-details-problem")).toContainText("40 characters");
  await page.getByTestId("create-pack").click();
  await expect(page.getByRole("alert").filter({ hasText: "40 characters" })).toBeVisible();
  expect(posted).toBe(false);
});

test("the products library lists the demo products with a new pack link", async ({ page }) => {
  await page.goto("/app/products");
  await expect(page.getByRole("heading", { name: "Products", exact: true })).toBeVisible();
  const bottle = page.getByTestId("product-entry").filter({ hasText: "Juniper glass water bottle" });
  await expect(bottle).toBeVisible();
  await expect(bottle.getByRole("link", { name: "New pack for this product" })).toHaveAttribute(
    "href",
    "/app/new?product=00000000-0000-4000-8000-000000000101",
  );
});
