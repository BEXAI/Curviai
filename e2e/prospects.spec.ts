import { expect, test } from "@playwright/test";

// P18-04 in the demo suite. The prospect tool is for OPS_EMAILS operators
// only, and demo mode has no signed in user, so here every operator page
// and route must not exist, a claim token on a share page changes nothing,
// and the takedown route finds nothing to take down. The operator flow
// itself (create, publish link only with proof, claim at signup, takedown)
// runs against the real migrations in apps/web/src/lib/prospects/
// prospects.test.ts, because it needs the database and a signed in operator.

const TOKEN = "0123456789abcdef0123456789abcdef01234567";

test("the prospect page and its routes do not exist for a visitor", async ({ page, request }) => {
  const response = await page.goto("/app/ops/prospects");
  if (new URL(page.url()).pathname !== "/login") {
    expect(response?.status()).toBe(404);
  }
  await expect(page.getByTestId("prospects-dashboard")).toHaveCount(0);

  expect((await request.get("/api/ops/prospects")).status()).toBe(404);
  expect((await request.post("/api/ops/prospects/credits", { data: { credits: 10 } })).status()).toBe(404);
  expect(
    (await request.post("/api/ops/prospects/3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5/link", { data: {} })).status(),
  ).toBe(404);
});

test("a takedown with an unknown claim finds nothing", async ({ request }) => {
  expect((await request.post(`/api/claims/${TOKEN}/takedown`)).status()).toBe(404);
  expect((await request.post("/api/claims/not-a-token/takedown")).status()).toBe(404);
});

test("a claim token on an ordinary share page changes nothing", async ({ page }) => {
  await page.goto(`/s/example?claim=${TOKEN}`);
  await expect(page.getByTestId("share-title")).toBeVisible();
  await expect(page.getByTestId("prospect-claim")).toHaveCount(0);
  await expect(page.getByTestId("prospect-footer")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Make mine" })).toHaveAttribute("href", /source=share/);
});
