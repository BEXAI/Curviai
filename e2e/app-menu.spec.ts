import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Demo-mode navigation only: these tests never create packs, change account
// settings, sign out, or send anything to a production service.
const menu = (page: Page) => page.locator("#app-navigation-menu");
// Keep the opener addressable while native showModal makes it inert.
const mobileTrigger = (page: Page) => page.locator(".app-nav > button[aria-controls='app-navigation-menu']");
const desktopTrigger = mobileTrigger;

async function openMobileMenu(page: Page) {
  const trigger = mobileTrigger(page);
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAccessibleName("Menu");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "App menu" })).toBeVisible();
  await expect(menu(page)).toHaveJSProperty("open", true);
  await expect.poll(() => menu(page).evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(menu(page).getByRole("link", { name: "Dashboard", exact: true })).toBeFocused();
  await expect(menu(page)).toHaveCSS("transform", "none");
}

async function expectMobileClosed(page: Page, restoreFocus = true) {
  await expect(menu(page)).not.toBeVisible();
  await expect(mobileTrigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("body")).not.toHaveCSS("position", "fixed");
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  if (restoreFocus) await expect(mobileTrigger(page)).toBeFocused();
}

async function contentOffset(page: Page) {
  return page.locator("#app-content").evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
  });
}

async function expectPanelWithinViewport(page: Page) {
  const geometry = await menu(page).evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const header = document.querySelector(".app-shell > header")!.getBoundingClientRect();
    return {
      x: panel.x,
      y: panel.y,
      right: panel.right,
      bottom: panel.bottom,
      width: panel.width,
      headerBottom: header.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.width).toBeCloseTo(224, 0);
  expect(geometry.x).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 8);
  expect(geometry.y).toBeGreaterThanOrEqual(geometry.headerBottom);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 8);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
}

test.describe("compact mobile app menu", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  for (const width of [320, 375, 390, 430]) {
    test(`is opaque, narrow and fully on screen at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.goto("/app");
      await openMobileMenu(page);

      await expectPanelWithinViewport(page);
      // A transparent background can be introduced by the theme's global
      // utility overrides even when the panel still carries a bg-night class.
      await expect(menu(page)).toHaveCSS("background-color", "rgb(7, 8, 13)");
      await expect(menu(page)).toHaveCSS("opacity", "1");
      await expect(menu(page).getByRole("button", { name: "Close menu" })).toBeVisible();
      await expect(menu(page).getByRole("link", { name: "Products", exact: true })).toBeVisible();
      await expect(mobileTrigger(page)).toHaveAttribute("aria-controls", "app-navigation-menu");
      expect(await menu(page).evaluate((element) => getComputedStyle(element, "::backdrop").backgroundColor))
        .not.toBe("rgba(0, 0, 0, 0)");

      await page.keyboard.press("Escape");
      await expectMobileClosed(page);
    });
  }

  for (const viewport of [{ width: 320, height: 480 }, { width: 667, height: 375 }]) {
    test(`scrolls inside the panel at ${viewport.width}x${viewport.height}`, async ({ page, browserName }) => {
      await page.setViewportSize(viewport);
      await page.goto("/app/new");
      await openMobileMenu(page);
      await expectPanelWithinViewport(page);
      await expect(menu(page)).toHaveCSS("overflow-y", "auto");
      expect(await menu(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

      const pageY = await page.evaluate(() => window.scrollY);
      if (browserName === "webkit") {
        // Playwright cannot synthesize mouse wheels in mobile WebKit.
        // Exercise focus-driven scrolling to the last reachable link there.
        await menu(page).getByRole("link", { name: "Contact us", exact: true }).focus();
      } else {
        await menu(page).hover();
        await page.mouse.wheel(0, 800);
      }
      await expect.poll(() => menu(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(menu(page).getByRole("link", { name: "Contact us", exact: true })).toBeInViewport();
      // Further wheel input at the panel's end must not scroll the document.
      if (browserName !== "webkit") await page.mouse.wheel(0, 800);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pageY);
      await page.keyboard.press("Escape");
      await expectMobileClosed(page);
    });
  }

  test("traps keyboard focus and restores the opener for every dismissal", async ({ page }) => {
    await page.goto("/app");

    for (const dismissal of ["escape", "button", "backdrop"] as const) {
      await mobileTrigger(page).focus();
      await page.keyboard.press("Enter");
      await expect(menu(page)).toBeVisible();
      await expect(menu(page).getByRole("link", { name: "Dashboard", exact: true })).toBeFocused();
      const controls = menu(page).locator("a[href]:visible, button:visible, [tabindex='0']:visible");
      await controls.first().focus();
      await page.keyboard.press("Shift+Tab");
      await expect(controls.last()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(controls.first()).toBeFocused();

      // A native modal also prevents programmatic focus from escaping to the
      // page, independently of the explicit Tab wraparound above.
      await page.locator("#app-content").evaluate((element) => (element as HTMLElement).focus());
      expect(await menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);

      if (dismissal === "escape") await page.keyboard.press("Escape");
      if (dismissal === "button") await menu(page).getByRole("button", { name: "Close menu" }).click();
      if (dismissal === "backdrop") await page.touchscreen.tap(4, 250);
      await expectMobileClosed(page);
      await expect(page).toHaveURL(/\/app$/);
    }
  });

  test("locks a scrolled page and restores its position through repeated openings", async ({ page, browserName }) => {
    await page.goto("/app/new");
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
    const initialStyles = await page.locator("body").getAttribute("style");

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await openMobileMenu(page);
      await expect(page.locator("body")).toHaveCSS("position", "fixed");
      await expect(page.locator("body")).toHaveCSS("top", "-300px");
      await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
      const header = (await page.locator(".app-shell > header").boundingBox())!;
      expect(header.y).toBeGreaterThanOrEqual(0);
      expect(header.y + header.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      const lockedY = await page.evaluate(() => window.scrollY);
      if (browserName !== "webkit") {
        await page.mouse.move(4, 250);
        await page.mouse.wheel(0, 500);
      }
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => window.scrollY)).toBe(lockedY);

      await page.keyboard.press("Escape");
      await expectMobileClosed(page);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
      expect((await page.locator("body").getAttribute("style")) ?? "").toBe(initialStyles ?? "");
    }
  });

  test("closes on navigation and browser Back and Forward without retaining a scroll lock", async ({ page }) => {
    await page.goto("/app/new");
    await openMobileMenu(page);
    await menu(page).getByRole("link", { name: "Products", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/products$/);
    await expectMobileClosed(page, false);

    await openMobileMenu(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/new$/);
    await expectMobileClosed(page, false);
    await openMobileMenu(page);
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/products$/);
    await expectMobileClosed(page, false);

    // Query-only history entries leave usePathname unchanged. A popstate
    // listener must still dismiss an open modal rather than leaving it stuck.
    await page.evaluate(() => history.pushState(null, "", "?menu-history=1"));
    await openMobileMenu(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/products$/);
    await expectMobileClosed(page, false);
    await openMobileMenu(page);
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/products\?menu-history=1$/);
    await expectMobileClosed(page, false);
  });

  test("preserves distinct browser-history scroll positions when dismissed by Back and Forward", async ({ page }) => {
    await page.goto("/app/new");
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
    await page.evaluate(() => {
      history.pushState(null, "", "?menu-scroll=second");
      window.scrollTo(0, 600);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);

    await openMobileMenu(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/new$/);
    await expectMobileClosed(page, false);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);

    await openMobileMenu(page);
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/new\?menu-scroll=second$/);
    await expectMobileClosed(page, false);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
  });

  test("nudges only the content and respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/app");
    const headerBefore = await page.locator(".app-shell > header").boundingBox();
    await openMobileMenu(page);
    await expect.poll(() => contentOffset(page)).toBe(-12);
    expect(await page.locator(".app-shell > header").boundingBox()).toEqual(headerBefore);
    await page.keyboard.press("Escape");
    await expectMobileClosed(page);
    await expect.poll(() => contentOffset(page)).toBe(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMobileMenu(page);
    await expect.poll(() => contentOffset(page)).toBe(0);
    await expectPanelWithinViewport(page);
    await page.keyboard.press("Escape");
    await expectMobileClosed(page);
  });

  test("releases the mobile modal and scroll lock when resized to desktop", async ({ page }) => {
    await page.goto("/app/new");
    await openMobileMenu(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(menu(page)).not.toBeVisible();
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("position", "fixed");
    await expect(desktopTrigger(page)).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => contentOffset(page)).toBe(0);

    await desktopTrigger(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "Billing", exact: true })).toBeFocused();
    expect(await menu(page).evaluate((element) => element.matches(":modal"))).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectMobileClosed(page, false);
    await openMobileMenu(page);
    await page.keyboard.press("Escape");
    await expectMobileClosed(page);
  });

  test("has no serious accessibility violations while open", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveTitle(/\S/);
    await openMobileMenu(page);
    const result = await new AxeBuilder({ page })
      .include("#app-navigation-menu")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical"))
      .toEqual([]);
  });
});

test.describe("desktop app menu", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps primary navigation visible and More as an anchored nonmodal popup", async ({ page }) => {
    await page.goto("/app");
    const navigation = page.getByRole("navigation", { name: "App", exact: true });
    await expect(navigation.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "New pack", exact: true })).toBeVisible();
    await expect(desktopTrigger(page)).toHaveAccessibleName("More");
    await desktopTrigger(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "Billing", exact: true })).toBeFocused();
    await expect(menu(page).getByRole("link", { name: "Dashboard", exact: true })).not.toBeVisible();
    await expect(menu(page)).toHaveCSS("background-color", "rgb(7, 8, 13)");
    expect(await menu(page).evaluate((element) => element.matches(":modal"))).toBe(false);
    await expect(page.locator("body")).not.toHaveCSS("position", "fixed");
    expect(await contentOffset(page)).toBe(0);

    const triggerBox = (await desktopTrigger(page).boundingBox())!;
    const panelBox = (await menu(page).boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
    expect(panelBox.x + panelBox.width).toBeCloseTo(triggerBox.x + triggerBox.width, 0);
    await page.locator("#app-content").click({ position: { x: 10, y: 10 } });
    await expect(menu(page)).not.toBeVisible();
    await expect(desktopTrigger(page)).toHaveAttribute("aria-expanded", "false");

    await desktopTrigger(page).click();
    await page.keyboard.press("Escape");
    await expect(menu(page)).not.toBeVisible();
    await expect(desktopTrigger(page)).toBeFocused();
  });
});
