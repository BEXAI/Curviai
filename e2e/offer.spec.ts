import { expect, test, type Page } from "@playwright/test";

// The founding member offer and per pack price framing (docs/phases/
// PHASE_18.md P18-21), in demo mode. The banner ships switched off (founder
// decision 18) and demo mode has no switch, so /api/offer answers no banner;
// a live offer is simulated by answering /api/offer in the browser, which is
// all the banner reads, so the rest of the suite never sees it.

const LIVE_OFFER = {
  founding: {
    code: "FOUNDING",
    annualCode: "FOUNDINGYEAR",
    monthlyUsd: 19,
    annualUsd: 190,
    seats: 50,
    left: 37,
    endsOn: "2026-11-30",
  },
};

async function offerIsLive(page: Page): Promise<void> {
  await page.route("**/api/offer", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_OFFER) }),
  );
}

test("the offer endpoint answers no banner while the offer is switched off", async ({ request }) => {
  const res = await request.get("/api/offer");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("public, max-age=60");
  expect(await res.json()).toEqual({ founding: null });
});

test("pricing shows a per pack price on every paid plan and the dated studio price, and no banner", async ({ page }) => {
  await page.goto("/pricing");
  // The plans sold online (P20-08: Agency is set up by email).
  for (const tier of ["starter", "growth", "pro"]) {
    await expect(page.getByTestId(`per-pack-${tier}`)).toHaveText(/^About \$\d+\.\d{2} per listing pack\.$/);
  }
  await expect(page.getByTestId("studio-comparison")).toContainText("per photo on October 1, 2026.");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("founding-offer-banner")).toHaveCount(0);
});

test("a live offer shows its seats and codes on pricing, and a hide sticks", async ({ page }) => {
  await offerIsLive(page);
  await page.goto("/pricing");
  const banner = page.getByTestId("founding-offer-banner");
  await expect(banner).toContainText("Founding member price: Starter at $19 a month for as long as you stay.");
  await expect(banner.getByTestId("founding-offer-seats")).toHaveText(
    "37 of 50 seats left, until November 30. Use code FOUNDING at checkout.",
  );
  await expect(banner).toContainText("Paying yearly? Use code FOUNDINGYEAR for $190 a year.");

  await banner.getByTestId("founding-offer-hide").click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("founding-offer-banner")).toHaveCount(0);
});

test("a live offer shows on the home page pricing section", async ({ page }) => {
  await offerIsLive(page);
  await page.goto("/");
  await expect(page.getByTestId("founding-offer-banner")).toContainText("Use code FOUNDING at checkout.");
});
