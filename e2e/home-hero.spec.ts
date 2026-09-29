import { expect, test, type Page } from "@playwright/test";

// The liquid metal hero on the home page. The headline is the LCP element
// and carries SEO, so it must be server HTML that is visible without
// JavaScript. The WebGL shader is an enhancement: headless browsers may or
// may not have WebGL2, so these checks accept the canvas or the static CSS
// metal, and only require the fallback where the shader must never run.

// CLAUDE.md rule 9, as in apps/web/src/components/marketing/claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

const hero = (page: Page) => page.getByTestId("liquid-metal-hero");

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the hero headline, subtitle and calls to action still show", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Shot once. Ready everywhere." })).toBeVisible();
    await expect(hero(page).getByText(/^AI product images for Amazon, Shopify/)).toBeVisible();
    await expect(hero(page).getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/signup");
    await expect(hero(page).getByRole("link", { name: "Test your main image free" })).toHaveAttribute(
      "href",
      "/tools/main-image-checker",
    );
    await expect(hero(page).getByTestId("hero-metal-fallback")).toBeVisible();
    await expect(hero(page).locator("canvas")).toHaveCount(0);
  });
});

test("the server HTML never hides the headline", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const h1 = /<h1\b[\s\S]*?<\/h1>/.exec(html)?.[0] ?? "";
  expect(h1).toContain("Shot once.");
  expect(h1).toContain("Ready everywhere.");
  expect(h1).not.toMatch(/style=|opacity/);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("keeps the static metal and never mounts the shader", async ({ page }) => {
    await page.goto("/");
    await expect(hero(page).getByTestId("hero-metal-fallback")).toBeVisible();
    // Past the idle callback's timeout, when the shader would have mounted.
    await page.waitForTimeout(2500);
    await expect(hero(page).getByTestId("hero-backdrop")).toHaveAttribute("data-shader", "off");
    await expect(hero(page).locator("canvas")).toHaveCount(0);
  });
});

test("phones get the static metal, not the shader", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/");
  await page.waitForTimeout(2500);
  await expect(hero(page).getByTestId("hero-backdrop")).toHaveAttribute("data-shader", "off");
  await expect(hero(page).locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Shot once. Ready everywhere." })).toBeVisible();
  await context.close();
});

test("the hero loads without errors and keeps the backdrop inside it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
  await expect(page.getByRole("heading", { level: 1, name: "Shot once. Ready everywhere." })).toBeVisible();
  // With WebGL2 the canvas mounts; without it the fallback stays. Either way
  // nothing in the hero is fixed to the viewport, so the library's offscreen
  // pause works and the metal never sits behind the rest of the page.
  const positions = await hero(page)
    .locator("*")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).position));
  expect(positions).not.toContain("fixed");
  await expect(hero(page).getByTestId("hero-metal-fallback")).toBeAttached();
});

test("hero copy follows the copy rules", async ({ page }) => {
  await page.goto("/");
  const text = await hero(page).innerText();
  expect(text).not.toMatch(FORBIDDEN_COPY);
  expect(text).toContain("Start free");
  // The before and after demo stays right under the hero.
  await expect(page.getByTestId("illustration-label").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Guides" }).getByRole("link")).toHaveCount(4);
});
