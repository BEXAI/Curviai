import { expect, test, type Page } from "@playwright/test";

// docs/phases/PHASE_18.md P18-01: landing params travel on the signup link
// without any storage, every primary call to action carries its page
// source, and the curvi_ft first touch cookie exists only after consent.

async function startFree(page: Page, scope: ReturnType<Page["locator"]>, name = "Start free"): Promise<URL> {
  const link = scope.getByRole("link", { name }).first();
  // SignupLink adds the page's landing params once the page has hydrated.
  await expect(link).toHaveAttribute("href", /source=.*utm_source=/);
  return new URL((await link.getAttribute("href")) ?? "", "http://localhost");
}

async function firstTouchCookie(page: Page) {
  return (await page.context().cookies()).find((cookie) => cookie.name === "curvi_ft");
}

test("a tagged landing reaches /signup with its UTM tags and the home source", async ({ page }) => {
  await page.goto("/?utm_source=reddit&utm_campaign=label_test");
  const hero = page.getByTestId("liquid-metal-hero");
  const link = hero.getByRole("link", { name: "Start free" });
  await expect(link).toHaveAttribute("href", /utm_campaign=label_test/);
  await link.click();
  await expect(page).toHaveURL(/\/signup\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get("source")).toBe("home");
  expect(url.searchParams.get("utm_source")).toBe("reddit");
  expect(url.searchParams.get("utm_campaign")).toBe("label_test");
});

test("each primary call to action carries its page source", async ({ page }) => {
  const cases: Array<{ path: string; source: string; scope: (p: Page) => ReturnType<Page["locator"]>; name?: string }> = [
    { path: "/", source: "header", scope: (p) => p.locator("header") },
    { path: "/", source: "home", scope: (p) => p.getByTestId("liquid-metal-hero") },
    { path: "/ai-product-images", source: "pillar", scope: (p) => p.locator("main") },
    { path: "/compare/ai-image-generators", source: "compare", scope: (p) => p.locator("main") },
    { path: "/channels/amazon-main/image-requirements", source: "channel", scope: (p) => p.getByTestId("channel-cta") },
    { path: "/for/jewelry", source: "category", scope: (p) => p.locator("main") },
    { path: "/help", source: "help", scope: (p) => p.locator("main"), name: "Get started" },
    { path: "/gallery", source: "gallery", scope: (p) => p.locator("main") },
    { path: "/s/example", source: "share", scope: (p) => p.locator("main"), name: "Make mine" },
    { path: "/pricing", source: "pricing", scope: (p) => p.getByTestId("tier-starter"), name: "Start with Starter" },
    { path: "/pricing", source: "pricing", scope: (p) => p.locator("main"), name: "Start free" },
  ];
  for (const item of cases) {
    await page.goto(`${item.path}${item.path.includes("?") ? "&" : "?"}utm_source=newsletter`);
    const url = await startFree(page, item.scope(page), item.name);
    expect(url.pathname, item.path).toBe("/signup");
    expect(url.searchParams.get("source"), item.path).toBe(item.source);
    expect(url.searchParams.get("utm_source"), item.path).toBe("newsletter");
  }
});

test("a pricing plan button carries the plan, the cadence and the landing tags", async ({ page }) => {
  await page.goto("/pricing?utm_source=newsletter&utm_campaign=q4");
  const url = await startFree(page, page.getByTestId("tier-growth"), "Start with Growth");
  expect(url.pathname).toBe("/signup");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    plan: "growth",
    cadence: "monthly",
    source: "pricing",
    utm_source: "newsletter",
    utm_campaign: "q4",
  });
});

test("the email capture form sends its source to /signup", async ({ page }) => {
  await page.goto("/tools/main-image-checker?utm_source=forum");
  const form = page.getByTestId("tool-pack-cta").locator("form");
  await expect(form.locator('input[name="utm_source"]')).toHaveValue("forum");
  await form.getByRole("textbox").fill("seller@example.com");
  await form.getByRole("button", { name: "Start free" }).click();
  await expect(page).toHaveURL(/\/signup\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get("source")).toBe("tools");
  expect(url.searchParams.get("utm_source")).toBe("forum");
});

test("no first touch cookie is written before or after a decline", async ({ page }) => {
  await page.goto("/?utm_source=reddit");
  await expect(page.getByTestId("liquid-metal-hero")).toBeVisible();
  expect(await firstTouchCookie(page)).toBeUndefined();
  await page.locator('[data-consent="decline"]').click();
  await page.goto("/pricing");
  expect(await firstTouchCookie(page)).toBeUndefined();
});

test("accepting cookies keeps the landing page as the first touch, once", async ({ page }) => {
  // Block third party scripts the accepted banner would load.
  await page.route(/^https:\/\/(?!localhost)/, (route) => route.abort());
  await page.goto("/for/jewelry?utm_source=reddit&utm_campaign=label_test");
  await page.getByRole("link", { name: "Help" }).first().click();
  await expect(page).toHaveURL(/\/help/);
  expect(await firstTouchCookie(page)).toBeUndefined();
  await page.locator('[data-consent="accept"]').click();
  await expect.poll(async () => (await firstTouchCookie(page))?.value ?? "").toContain("label_test");
  const value = JSON.parse(decodeURIComponent((await firstTouchCookie(page))?.value ?? "{}")) as Record<string, string>;
  expect(value).toMatchObject({ utm_source: "reddit", utm_campaign: "label_test", landing_path: "/for/jewelry" });
  // A later tagged visit never overwrites it.
  await page.goto("/?utm_source=tiktok");
  await expect(page.getByTestId("liquid-metal-hero")).toBeVisible();
  const again = JSON.parse(decodeURIComponent((await firstTouchCookie(page))?.value ?? "{}")) as Record<string, string>;
  expect(again.utm_source).toBe("reddit");
});
