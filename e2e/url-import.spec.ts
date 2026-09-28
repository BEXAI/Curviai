import { expect, test } from "@playwright/test";

// Demo mode: no env vars. The import routes' outside fetches are replaced
// with fixed answers where a test needs a product, so no test reaches the
// internet.

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const PRODUCT = {
  platform: "shopify",
  sourceUrl: "https://store.example.com/products/linen-apron",
  title: "Linen Apron",
  description: "Stone washed linen.",
  bullets: ["Stone washed linen", "Two deep pockets"],
  images: [{ url: "https://cdn.e2e.invalid/apron-front.png" }, { url: "https://cdn.e2e.invalid/apron-back.png" }],
  partial: false,
};

test("a product link fills the form and the picked photo goes into the pack", async ({ page }) => {
  let importedLink: string | null = null;
  await page.route("**/api/imports/product", async (route) => {
    importedLink = (route.request().postDataJSON() as { url: string }).url;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ product: PRODUCT }) });
  });
  let photoLink: string | null = null;
  await page.route("**/api/imports/photo", async (route) => {
    photoLink = (route.request().postDataJSON() as { url: string }).url;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        key: `ws/${DEMO_WORKSPACE_ID}/src/e2e-imported`,
        sha256: "b".repeat(64),
        kind: "image",
      }),
    });
  });
  await page.route("https://cdn.e2e.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") }),
  );
  const captured: { body: { uploads?: Array<{ key: string }>; newProductTitle?: string; userDescription?: string } | null } =
    { body: null };
  page.on("request", (request) => {
    if (request.url().endsWith("/api/jobs") && request.method() === "POST") {
      captured.body = request.postDataJSON();
    }
  });

  await page.goto("/app/new");
  await page.getByLabel("Start from your product link").fill("store.example.com/products/linen-apron");
  await page.getByRole("button", { name: "Import", exact: true }).click();

  await expect(page.getByTestId("url-import-result")).toContainText("Imported Linen Apron.");
  expect(importedLink).toBe("store.example.com/products/linen-apron");
  await expect(page.getByLabel("Product", { exact: true })).toHaveValue("new");
  await expect(page.getByLabel("Product name")).toHaveValue("Linen Apron");
  await expect(page.getByLabel("Anything we should know")).toHaveValue("Stone washed linen\nTwo deep pockets");

  await expect(page.getByTestId("url-import-photo")).toHaveCount(2);
  await page.getByRole("button", { name: "Use photo 2" }).click();
  await expect(page.getByTestId("upload-done")).toContainText("Uploaded photo 2 from your listing");
  expect(photoLink).toBe("https://cdn.e2e.invalid/apron-back.png");
  await expect(page.getByRole("button", { name: "Use photo 2" })).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("create-pack").click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  expect(captured.body?.uploads?.[0]?.key).toBe(`ws/${DEMO_WORKSPACE_ID}/src/e2e-imported`);
  expect(captured.body?.newProductTitle).toBe("Linen Apron");
  expect(captured.body?.userDescription).toBe("Stone washed linen\nTwo deep pockets");
});

test("the import route refuses plain http and private links with a plain message", async ({ page }) => {
  await page.goto("/app/new");
  const input = page.getByLabel("Start from your product link");

  await input.fill("http://store.example.com/products/linen-apron");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("url-import-error")).toHaveText("Paste the full product link, starting with https.");

  await input.fill("https://169.254.169.254/products/a");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("url-import-error")).toContainText("does not point to a public store page");

  await input.fill("https://store.example.com/about-us");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("url-import-error")).toContainText("Shopify links have /products/ in them");
});

test("the import API answers 400 for a metadata address without fetching it", async ({ request }) => {
  const response = await request.post("/api/imports/product", {
    data: { url: "https://169.254.169.254/latest/meta-data/products/x" },
  });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as { reason: string };
  expect(body.reason).toBe("blocked_host");
});

test("on the demo server a picked photo shows the imports are off notice", async ({ page }) => {
  await page.route("**/api/imports/product", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ product: PRODUCT }) }),
  );
  await page.route("https://cdn.e2e.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") }),
  );
  await page.goto("/app/new");
  await page.getByLabel("Start from your product link").fill(PRODUCT.sourceUrl);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("button", { name: "Use photo 1" }).click();
  await expect(page.getByTestId("upload-notice")).toContainText("Photo imports are off on this demo server");
});
