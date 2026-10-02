import { expect, test } from "@playwright/test";

// P18-18, demo mode: the store image audit. The demo has no platform_settings
// table, so the audit is on here (in production it ships switched off). The
// audit route's outside fetches are replaced with a fixed answer, so no test
// reaches the internet.

const REPORT = {
  store: "candles.example.com",
  channel: { key: "amazon", name: "Amazon" },
  summary: { listed: 3, checked: 2, failing: 1, thin: 2, notChecked: 1, thinImageCount: 3 },
  products: [
    {
      title: "Amber Candle",
      url: "https://candles.example.com/products/amber-candle",
      imageCount: 4,
      result: { status: "checked", pass: true, width: 2000, height: 2000, rows: [] },
    },
    {
      title: "Fig Candle",
      url: "https://candles.example.com/products/fig-candle",
      imageCount: 1,
      result: {
        status: "checked",
        pass: false,
        width: 1200,
        height: 1200,
        rows: [
          { key: "fill", label: "Product fills 85 to 90 percent of the frame", pass: false, measured: "Measured fill 50.0 percent" },
        ],
      },
    },
    {
      title: "Sea Candle",
      url: "https://candles.example.com/products/sea-candle",
      imageCount: 1,
      result: { status: "not_checked", reason: "timeout" },
    },
  ],
};

test("a store audit shows a free summary and gates the per product table behind an email", async ({ page }) => {
  let sent: { store: string; channel: string; captchaToken: string } | null = null;
  await page.route("**/api/tools/store-audit", async (route) => {
    sent = route.request().postDataJSON() as { store: string; channel: string; captchaToken: string };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ audit: REPORT }) });
  });

  await page.goto("/tools/store-image-audit");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Shopify Store Image Audit");
  await page.getByLabel("Your Shopify store address").fill("candles.example.com");
  await page.getByRole("button", { name: "Audit my store" }).click();

  await expect(page.getByTestId("store-audit-summary")).toHaveText(
    "1 of 2 main images would not pass Amazon's rules. 2 products have fewer than 3 images.",
  );
  // The demo build has no Turnstile site key. It still sends the canonical
  // empty token field; configured builds must provide a verified token.
  expect(sent).toEqual({ store: "candles.example.com", channel: "amazon", captchaToken: "" });
  await expect(page.getByText("1 product could not be checked, so it is left out of the count.")).toBeVisible();
  await expect(page.getByTestId("store-audit-table")).toHaveCount(0);

  const gate = page.getByTestId("email-gate");
  await gate.getByLabel("Email").fill("owner@example.com");
  await gate.getByRole("button", { name: "Show full results" }).click();
  const table = page.getByTestId("store-audit-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("Fig Candle");
  await expect(table).toContainText("Fails: Product fills 85 to 90 percent of the frame");
  await expect(table).toContainText("Not checked");
  await expect(page.getByTestId("store-audit-signup")).toHaveAttribute("href", /source=store_audit/);
});

test("a refused store address shows the plain reason", async ({ page }) => {
  await page.route("**/api/tools/store-audit", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Amazon stores cannot be audited here. Check one Amazon main image with the free checker instead.",
        reason: "amazon",
      }),
    }),
  );
  await page.goto("/tools/store-image-audit");
  await page.getByLabel("Your Shopify store address").fill("amazon.com");
  await page.getByRole("button", { name: "Audit my store" }).click();
  await expect(page.getByTestId("store-audit-error")).toContainText("Amazon stores cannot be audited here.");
});

test("the audit route refuses a private address without fetching it", async ({ request }) => {
  const response = await request.post("/api/tools/store-audit", { data: { store: "localhost" } });
  expect(response.status()).toBe(400);
  expect((await response.json()).reason).toBe("blocked_host");
});
