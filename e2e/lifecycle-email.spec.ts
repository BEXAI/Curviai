import { createHash, createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// P18-06, demo mode: the email gate's unticked marketing consent box, and
// the unsubscribe page with a valid and a forged link. Demo mode has no
// database, so links verify against the fixed demo secret
// (apps/web/src/lib/email/config.ts DEMO_LINK_SECRET) and the suppression
// lives in memory. The token format is packages/email/src/links.ts.

const DEMO_LINK_SECRET = "curvi-demo-link-secret";

function unsubscribeToken(email: string, secret = DEMO_LINK_SECRET): string {
  const key = createHash("sha256").update(email).digest("hex");
  const signature = createHmac("sha256", secret).update(`curvi-link:v1:unsub:${key}`).digest("base64url");
  return `unsub.${key}.${signature}`;
}

const REPORT = {
  store: "candles.example.com",
  channel: { key: "amazon", name: "Amazon" },
  summary: { listed: 1, checked: 1, failing: 0, thin: 0, notChecked: 0, thinImageCount: 3 },
  products: [
    {
      title: "Amber Candle",
      url: "https://candles.example.com/products/amber-candle",
      imageCount: 4,
      result: { status: "checked", pass: true, width: 2000, height: 2000, rows: [] },
    },
  ],
};

test("the email gate offers an unticked consent box and sends the tick only when given", async ({ page }) => {
  await page.route("**/api/tools/store-audit", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ audit: REPORT }) }),
  );
  let lead: Record<string, unknown> | null = null;
  await page.route("**/api/leads", async (route) => {
    lead = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/tools/store-image-audit");
  await page.getByLabel("Your Shopify store address").fill("candles.example.com");
  await page.getByRole("button", { name: "Audit my store" }).click();

  const gate = page.getByTestId("email-gate");
  const consent = gate.getByLabel("Also send me tips on listing images and the occasional offer");
  await expect(consent).toBeVisible();
  await expect(consent).not.toBeChecked();
  await consent.check();
  await gate.getByLabel("Email").fill("owner@example.com");
  await gate.getByRole("button", { name: "Show full results" }).click();
  await expect(page.getByTestId("store-audit-table")).toBeVisible();
  expect(lead).toMatchObject({ email: "owner@example.com", source: "store-audit", marketingConsent: true });
});

test("the unsubscribe page asks once, then unsubscribes with a valid link", async ({ page }) => {
  await page.goto(`/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken("seller@example.com"))}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unsubscribe");
  await expect(
    page.getByText("Stop tips and offers from Curvi? You will still get emails about packs you make and payments."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByTestId("unsubscribe-done")).toHaveText(
    "You are unsubscribed. Curvi will not send you tips or offers again.",
  );
});

test("the unsubscribe page refuses a forged link", async ({ page }) => {
  await page.goto(`/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken("seller@example.com", "not-the-secret"))}`);
  await expect(page.getByTestId("unsubscribe-invalid")).toBeVisible();
  await expect(page.getByRole("button", { name: "Unsubscribe" })).toHaveCount(0);
});

test("the one click unsubscribe POST answers 200 with no redirect, and a forged one 400", async ({ request }) => {
  const valid = await request.post(`/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken("seller@example.com"))}`, {
    form: { "List-Unsubscribe": "One-Click" },
    maxRedirects: 0,
  });
  expect(valid.status()).toBe(200);
  const forged = await request.post(
    `/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken("seller@example.com", "not-the-secret"))}`,
    { form: { "List-Unsubscribe": "One-Click" }, maxRedirects: 0 },
  );
  expect(forged.status()).toBe(400);
});
