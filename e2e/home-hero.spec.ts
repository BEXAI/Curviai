import { expect, test, type Page } from "@playwright/test";

// The liquid metal hero on the home page. The headline is the LCP element
// and carries SEO, so it must be server HTML that is visible without
// JavaScript. The WebGL shader is an enhancement: the tests that need it run
// only where this browser would run it (WebGL2 and the device gate), and the
// rest check the static CSS metal and the fallbacks.

// CLAUDE.md rule 9, as in apps/web/src/components/marketing/claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;
const HEADLINE = "Shot once. Ready everywhere.";
const NIGHT = [7, 8, 13] as const;

const hero = (page: Page) => page.getByTestId("liquid-metal-hero");
const backdrop = (page: Page) => page.getByTestId("hero-backdrop");
// The metal is fixed behind the whole home page, outside the hero section.
const heroCanvas = (page: Page) => backdrop(page).locator("canvas");

type ShaderMount = { currentSpeed: number; speed: number };

/** The shader's speed as the library reports it; 0 means its animation loop is stopped. */
function shaderSpeed(page: Page) {
  return page.evaluate(() => {
    // The library also tags a <style> in the head with this attribute; the mount is the div.
    const host = document.querySelector("div[data-paper-shader]") as (Element & { paperShaderMount?: ShaderMount }) | null;
    return host?.paperShaderMount?.currentSpeed ?? null;
  });
}

/** Whether this browser passes the hero's shader gate: the same checks as liquid-metal-backdrop.tsx. */
function shaderCapable(page: Page) {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const desktop = matchMedia("(min-width: 20rem) and (min-height: 20rem)").matches;
    const memory = typeof nav.deviceMemory !== "number" || nav.deviceMemory >= 4;
    const cores = !(nav.hardwareConcurrency > 0) || nav.hardwareConcurrency >= 4;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return desktop && memory && cores && !reduced && document.createElement("canvas").getContext("webgl2") !== null;
  });
}

async function gotoWithShader(page: Page) {
  await page.goto("/");
  test.skip(!(await shaderCapable(page)), "this browser would not run the shader (no WebGL2, or the device gate)");
  await expect(backdrop(page)).toHaveAttribute("data-shader", "on", { timeout: 10000 });
  await expect(heroCanvas(page)).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByTestId("hero-motion-toggle")).toBeVisible({ timeout: 10000 });
}

function luminance([r, g, b]: readonly number[]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The worst contrast of a hero text element against the rendered background
 * behind it: the glyphs are hidden (a text shadow halo stays, it is part of
 * the background), the page is captured, and the brightest pixel inside each
 * of the element's line boxes is compared with its text color.
 */
async function worstContrast(page: Page, selector: string): Promise<number> {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const { color, boxes } = await target.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      color: getComputedStyle(element).color,
      boxes: [...range.getClientRects()].filter((r) => r.width > 2).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
    };
  });
  const style = await page.addStyleTag({
    content: "[data-testid=liquid-metal-hero] * { color: transparent !important; transition: none !important; }",
  });
  const shot = (await page.screenshot()).toString("base64");
  await style.evaluate((node) => (node as Element).remove());
  const brightest = await page.evaluate(
    async ({ shot, boxes }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${shot}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(image, 0, 0);
      const scale = image.width / window.innerWidth;
      let best = [0, 0, 0];
      let bestSum = -1;
      for (const box of boxes) {
        const x = Math.max(0, Math.floor(box.x * scale));
        const y = Math.max(0, Math.floor(box.y * scale));
        const w = Math.min(image.width - x, Math.ceil(box.w * scale));
        const h = Math.min(image.height - y, Math.ceil(box.h * scale));
        if (w <= 0 || h <= 0) continue;
        const data = context.getImageData(x, y, w, h).data;
        for (let i = 0; i < data.length; i += 4) {
          const sum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
          if (sum > bestSum) {
            bestSum = sum;
            best = [data[i]!, data[i + 1]!, data[i + 2]!];
          }
        }
      }
      return best;
    },
    { shot, boxes },
  );
  const text = /rgba?\(([^)]+)\)/.exec(color)?.[1]?.split(/[ ,/]+/).map(Number) ?? [255, 255, 255];
  return contrast(luminance(text), luminance(brightest));
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the hero headline, subtitle and calls to action still show", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible();
    await expect(hero(page).getByText(/^Turn one photo into AI product images for Amazon, Shopify/)).toBeVisible();
    await expect(hero(page).getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/signup?source=home");
    await expect(hero(page).getByRole("link", { name: "Test your main image free" })).toHaveAttribute(
      "href",
      "/tools/main-image-checker",
    );
    await expect(page.getByTestId("hero-metal-fallback")).toBeVisible();
    await expect(heroCanvas(page)).toHaveCount(0);
    await expect(page.getByTestId("hero-motion-toggle")).toHaveCount(0);
  });

  test("nothing hides the headline or subtitle at the first frame", async ({ page }) => {
    await page.goto("/");
    // Freeze every entrance animation at its first frame, as a slow device
    // would paint it, then check the text and every ancestor up to body.
    await page.evaluate(() =>
      document.getAnimations().forEach((animation) => {
        // Scroll driven reveals below the fold run on a progress timeline; only time based ones rewind.
        if (animation.timeline === document.timeline) {
          animation.pause();
          animation.currentTime = 0;
        }
      }),
    );
    for (const selector of ["[data-testid=liquid-metal-hero] h1", "[data-testid=liquid-metal-hero] h1 + p"]) {
      const opacities = await page.locator(selector).evaluate((element) => {
        const values: string[] = [];
        for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
          values.push(getComputedStyle(node).opacity);
        }
        return values;
      });
      expect(opacities.length, selector).toBeGreaterThan(2);
      expect(opacities.every((value) => value === "1"), `${selector}: ${opacities.join(" ")}`).toBe(true);
    }
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

  test("keeps the static metal, never mounts the shader and shows every item at once", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("hero-metal-fallback")).toBeVisible();
    // Nothing in the hero animates or waits at opacity 0 through a delay. The
    // logo color layer over the metal is a static overlay at partial opacity.
    const hidden = await hero(page)
      .locator("*")
      .evaluateAll((elements) =>
        elements
          .filter(
            (element) =>
              element.getAnimations().length > 0 ||
              (getComputedStyle(element).opacity !== "1" && element.getAttribute("data-testid") !== "hero-metal-hue"),
          )
          .map((element) => element.className.toString().slice(0, 60)),
      );
    expect(hidden).toEqual([]);
    // Past the idle callback's timeout, when the shader would have mounted.
    await page.waitForTimeout(2500);
    await expect(backdrop(page)).toHaveAttribute("data-shader", "off");
    await expect(heroCanvas(page)).toHaveCount(0);
    await expect(page.getByTestId("hero-motion-toggle")).toHaveCount(0);
  });

  test("the wine headline line keeps 3:1 and the note 4.5:1 over the static metal", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    expect(await worstContrast(page, "[data-testid=liquid-metal-hero] h1 span:last-child")).toBeGreaterThanOrEqual(3);
    expect(await worstContrast(page, "[data-testid=liquid-metal-hero] h1 span:first-child")).toBeGreaterThanOrEqual(4.5);
    expect(await worstContrast(page, "[data-testid=liquid-metal-hero] h1 ~ p >> nth=1")).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("phones and tablets", () => {
  for (const viewport of [
    { width: 390, height: 844, name: "a phone" },
    { width: 844, height: 390, name: "a phone in landscape" },
    { width: 1024, height: 768, name: "a tablet in landscape" },
  ]) {
    test(`${viewport.name} gets the same moving metal rule as a desktop`, async ({ browser }) => {
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const desktopPage = await desktop.newPage();
      await desktopPage.goto("/");
      await desktopPage.waitForTimeout(2500);
      const expected = await backdrop(desktopPage).getAttribute("data-shader");
      await desktop.close();
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto("/");
      await page.waitForTimeout(2500);
      await expect(backdrop(page)).toHaveAttribute("data-shader", expected ?? "off");
      await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible();
      await context.close();
    });
  }

  test("the hero text keeps its contrast over the phone metal", async ({ browser }) => {
    for (const width of [320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1200);
      const wine = await worstContrast(page, "[data-testid=liquid-metal-hero] h1 span:last-child");
      expect(wine, `wine line at ${width}px`).toBeGreaterThanOrEqual(3);
      for (const selector of [
        "[data-testid=liquid-metal-hero] h1 + p",
        "[data-testid=liquid-metal-hero] h1 ~ p >> nth=1",
        "[data-testid=liquid-metal-hero] a >> nth=1",
      ]) {
        expect(await worstContrast(page, selector), `${selector} at ${width}px`).toBeGreaterThanOrEqual(4.5);
      }
      await context.close();
    }
  });

  test("no home section is wider than a small phone", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto("/");
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("main section")]
        .filter((section) => section.scrollWidth > section.clientWidth + 1)
        .map((section) => section.getAttribute("aria-labelledby")),
    );
    expect(wide).toEqual([]);
    await context.close();
  });
});

test("the hero loads without errors and the metal sits fixed behind the page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
  await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible();
  // The metal is one fixed layer behind every section, outside the hero;
  // nothing in the hero blurs what is behind it on every frame the shader draws.
  expect(await backdrop(page).evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  const styles = await hero(page)
    .locator("*")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, backdrop: style.backdropFilter };
      }),
    );
  expect(styles.filter((style) => style.backdrop !== "none")).toEqual([]);
  await expect(page.getByTestId("hero-metal-fallback")).toBeAttached();
});

test.describe("the WebGL shader", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("turns on for a capable desktop and fades in over the static metal", async ({ page }) => {
    await gotoWithShader(page);
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
    await expect(page.getByTestId("hero-metal-fallback")).toBeAttached();
  });

  test("rests after a while without input and moves again on the next input", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoWithShader(page);
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
    // IDLE_PAUSE_MS is 45 seconds.
    await expect.poll(() => shaderSpeed(page), { timeout: 60_000, intervals: [5_000] }).toBe(0);
    await page.mouse.move(200, 200);
    await page.mouse.move(240, 220);
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
  });

  test("keeps moving behind every section as the page scrolls", async ({ page }) => {
    await gotoWithShader(page);
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
    await expect(backdrop(page)).toBeInViewport();
  });

  test("stops live when reduced motion is switched on", async ({ page }) => {
    await gotoWithShader(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(heroCanvas(page)).toHaveCount(0);
    await expect(backdrop(page)).toHaveAttribute("data-shader", "off");
    await expect(page.getByTestId("hero-motion-toggle")).toHaveCount(0);
  });

  test("can be paused and played, and the choice is remembered", async ({ page }) => {
    await gotoWithShader(page);
    const toggle = page.getByTestId("hero-motion-toggle");
    await expect(toggle).toHaveText("Pause background motion");
    await toggle.click();
    await expect(toggle).toHaveText("Play background motion");
    await expect.poll(() => shaderSpeed(page)).toBe(0);
    await page.reload();
    await expect(page.getByTestId("hero-motion-toggle")).toHaveText("Play background motion", { timeout: 10000 });
    await expect.poll(() => shaderSpeed(page)).toBe(0);
    await page.getByTestId("hero-motion-toggle").click();
    await expect.poll(() => shaderSpeed(page)).toBeGreaterThan(0);
  });

  test("the wine headline line keeps 3:1 over the moving metal", async ({ page }) => {
    await gotoWithShader(page);
    await page.evaluate(() => document.fonts.ready);
    for (const frame of [0, 20000, 45000, 80000]) {
      await page.evaluate((frame) => {
        const host = document.querySelector("div[data-paper-shader]") as Element & {
          paperShaderMount: { setSpeed: (speed: number) => void; setFrame: (frame: number) => void };
        };
        host.paperShaderMount.setSpeed(0);
        host.paperShaderMount.setFrame(frame);
      }, frame);
      const wine = await worstContrast(page, "[data-testid=liquid-metal-hero] h1 span:last-child");
      expect(wine, `frame ${frame}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("falls back to the static metal without WebGL2", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        return type === "webgl2" ? null : (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof getContext;
    });
    await page.goto("/");
    await page.waitForTimeout(3000);
    await expect(backdrop(page)).toHaveAttribute("data-shader", "off");
    await expect(heroCanvas(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("keeps the page when the shader chunk fails to load", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let aborted = false;
    await page.route("**/_next/static/chunks/**", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      // A string only the shader library's own chunk carries.
      if (body.includes("WebGL is not supported in this browser")) {
        aborted = true;
        await route.abort();
        return;
      }
      await route.fulfill({ response, body });
    });
    await page.goto("/");
    test.skip(!(await shaderCapable(page)), "this browser would not load the shader chunk");
    await expect.poll(() => aborted, { timeout: 10000 }).toBe(true);
    await expect(backdrop(page)).toHaveAttribute("data-shader", "off", { timeout: 10000 });
    await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible();
    await expect(page.locator('img[src="/home/before-car.jpg"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("keyboard", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the hero calls to action show a focus ring of at least 3:1 on night", async ({ page }) => {
    await page.goto("/");
    const start = hero(page).getByRole("link", { name: "Start free" });
    for (let i = 0; i < 30 && !(await start.evaluate((element) => element === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(start).toBeFocused();
    const ring = await start.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring.style).toBe("solid");
    expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
    const rgb = /rgba?\(([^)]+)\)/.exec(ring.color)?.[1]?.split(/[ ,/]+/).map(Number) ?? [0, 0, 0];
    expect(contrast(luminance(rgb), luminance(NIGHT))).toBeGreaterThanOrEqual(3);

    await page.keyboard.press("Tab");
    const secondary = hero(page).getByRole("link", { name: "Test your main image free" });
    await expect(secondary).toBeFocused();
    await expect(secondary).toHaveCSS("outline-color", "rgb(255, 255, 255)");
  });
});

test.describe("below the hero", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the FAQ aside sticks under the header and sections reveal as they scroll in", async ({ page }) => {
    await page.goto("/");
    // The page wrapper clips overflow without becoming a scroll container.
    const tile = page.locator("#home-pricing-title").locator("xpath=ancestor::section").locator(".reveal").first();
    // The scroll timeline can initialize after load; await the same initial opacity.
    await expect.poll(async () => Number(await tile.evaluate((element) => getComputedStyle(element).opacity)), { timeout: 5000 }).toBeLessThan(0.5);
    await tile.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect.poll(async () => Number(await tile.evaluate((element) => getComputedStyle(element).opacity))).toBe(1);

    const faq = page.locator("section[aria-labelledby=home-faq-title]");
    const aside = page.locator("#home-faq-title").locator("xpath=ancestor::div[contains(@class,'lg:sticky')]");
    await faq.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 300));
    await expect.poll(async () => Math.round((await aside.boundingBox())?.y ?? 0)).toBe(96);
  });

  test("every channel tile links to a requirements page that exists", async ({ page, request }) => {
    await page.goto("/");
    const hrefs = await page
      .locator('main a[href^="/channels/"]')
      .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href") ?? ""))]);
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const href of hrefs) {
      expect((await request.get(href)).status(), href).toBe(200);
    }
  });
});

test("hero copy follows the copy rules", async ({ page }) => {
  await page.goto("/");
  const text = await hero(page).innerText();
  expect(text).not.toMatch(FORBIDDEN_COPY);
  expect(text).toContain("Start free");
  // The before and after demo stays right under the hero.
  await expect(page.locator('img[src="/home/before-car.jpg"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Guides" }).getByRole("link")).toHaveCount(4);
});
