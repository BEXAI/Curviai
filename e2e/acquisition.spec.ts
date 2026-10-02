import { expect, test } from "@playwright/test";

// The acquisition gate (docs/phases/PHASE_18.md P18-03), in demo mode. The
// e2e server runs open; the waitlist is simulated by answering /api/status
// in the browser, which is all the call to action reads, so the rest of the
// suite keeps an open gate. CURVI_DEMO_ACQUISITION=waitlist does the same on
// a local server (unit tests cover it, and the /signup notice).

test("the status endpoint answers open with a short public cache and nothing else", async ({ request }) => {
  const res = await request.get("/api/status");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("public, max-age=30");
  expect(await res.json()).toEqual({ acquisition: "open" });
});

test("while packs are paused the home Start free becomes a waitlist that stores a packs-paused lead", async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ acquisition: "waitlist" }) }),
  );
  await page.goto("/");
  const hero = page.getByTestId("liquid-metal-hero");
  const cta = hero.getByTestId("waitlist-cta");
  await expect(cta).toHaveText("Get notified when packs are back");
  await expect(hero.getByRole("link", { name: "Start free" })).toHaveCount(0);

  await cta.click();
  const dialog = page.getByTestId("waitlist-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Packs are paused for a short while.");
  await dialog.getByLabel("Email").fill("waitlist-e2e@example.com");
  const lead = page.waitForRequest((req) => req.url().endsWith("/api/leads") && req.method() === "POST");
  await dialog.getByRole("button", { name: "Notify me" }).click();
  const body = (await lead).postDataJSON() as { email: string; source: string };
  expect(body).toMatchObject({ email: "waitlist-e2e@example.com", source: "packs-paused" });
  await expect(dialog.getByTestId("waitlist-done")).toHaveText("Thanks. We will email you the moment packs are back.");
});

test("while packs are paused every pricing call to action becomes the waitlist", async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ acquisition: "waitlist" }) }),
  );
  await page.goto("/pricing");
  const main = page.locator("main");
  // Three plan buttons (P20-08: Agency is set up by email), Start free and Buy credits.
  await expect(main.getByTestId("waitlist-cta")).toHaveCount(5);
  await expect(main.getByTestId("cta-free")).toHaveCount(0);
  await expect(main.getByRole("link", { name: /^Start with / })).toHaveCount(0);
  await expect(main.locator('a[href^="/signup"]')).toHaveCount(0);
});

test("while packs run the home Start free stays a signup link", async ({ page }) => {
  await page.goto("/");
  const hero = page.getByTestId("liquid-metal-hero");
  await expect(hero.getByRole("link", { name: "Start free" })).toBeVisible();
  await expect(hero.getByTestId("waitlist-cta")).toHaveCount(0);
});
