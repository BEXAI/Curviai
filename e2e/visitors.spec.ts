import { expect, test, type Page, type Request } from "@playwright/test";

// The cookieless visitor count (apps/web/src/lib/visits). The e2e server
// runs in demo mode with no database, so the route stores nothing; these
// check the browser side (one beacon per page, no cookies, no storage) and
// that the operator page does not exist for a visitor.
//
// A browser driven by Playwright reports navigator.webdriver true, and the
// beacon skips such browsers on purpose. The tests that need a beacon make
// the page look like a person's browser first.

async function asPerson(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
  });
}

function isBeacon(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/visits";
}

test("loading the home page sends one beacon with the referrer to the visits route", async ({ page }) => {
  await asPerson(page);
  const beacons: Request[] = [];
  page.on("request", (request) => {
    if (isBeacon(request)) {
      beacons.push(request);
    }
  });
  const first = page.waitForRequest(isBeacon);
  await page.goto("/?utm_source=Newsletter&utm_campaign=launch&email=a%40b.com", {
    referer: "https://news.ycombinator.com/",
  });
  const request = await first;
  const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
  expect(body).toMatchObject({ path: "/", utm_source: "Newsletter", utm_campaign: "launch" });
  // The first page of a visit carries the site that sent it.
  expect(String(body.referrer)).toContain("news.ycombinator.com");
  expect(JSON.stringify(body)).not.toContain("a@b.com");
  const response = await request.response();
  expect(response?.status()).toBe(204);

  // Nothing is kept on the device for the count.
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(stored.local.filter((key) => /visit/i.test(key))).toEqual([]);
  expect(stored.session.filter((key) => /visit/i.test(key))).toEqual([]);
  const cookies = await page.context().cookies();
  expect(cookies.filter((cookie) => /visit/i.test(cookie.name))).toEqual([]);

  // Still exactly one beacon once the page has settled.
  await page.waitForTimeout(500);
  expect(beacons).toHaveLength(1);
});

test("a client side route change sends another beacon without the referrer", async ({ page }) => {
  await asPerson(page);
  const first = page.waitForRequest(isBeacon);
  await page.goto("/");
  await first;
  const second = page.waitForRequest(isBeacon);
  await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a[href="/pricing"]');
    if (!link) {
      throw new Error("no pricing link on the home page");
    }
    link.click();
  });
  const request = await second;
  const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
  expect(body.path).toBe("/pricing");
  expect(body).not.toHaveProperty("referrer");
});

test("a browser driven by automation sends no beacon", async ({ page }) => {
  let sent = 0;
  page.on("request", (request) => {
    if (isBeacon(request)) {
      sent += 1;
    }
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(sent).toBe(0);
});

test("the visits route answers 204 to bots and to other sites", async ({ request }) => {
  const bot = await request.post("/api/visits", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    data: JSON.stringify({ path: "/" }),
  });
  expect(bot.status()).toBe(204);
  const crossSite = await request.post("/api/visits", {
    headers: { origin: "https://evil.example" },
    data: JSON.stringify({ path: "/" }),
  });
  expect(crossSite.status()).toBe(204);
  expect(await crossSite.text()).toBe("");
});

test("the operator visitors page is not reachable for a visitor who is not signed in", async ({ page }) => {
  const response = await page.goto("/app/ops/visitors");
  // With Supabase configured the middleware sends a signed out visitor to
  // /login; without it (this suite) the page itself answers 404.
  if (new URL(page.url()).pathname === "/login") {
    return;
  }
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId("visitors-dashboard")).toHaveCount(0);
  await expect(page.getByTestId("visitors-notice")).toHaveCount(0);
});

test("the privacy policy explains the cookieless count", async ({ page }) => {
  await page.goto("/privacy");
  const section = page.getByTestId("privacy-visitor-count");
  await expect(section).toContainText("without cookies");
  await expect(section).toContainText("never store your IP address");
});
