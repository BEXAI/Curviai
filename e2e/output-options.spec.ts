import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Section 3 "How your images look" end to end on a phone (docs/phases/
// PHASE_15.md, Tests), against demo mode: in memory services and a
// simulated pack that advances one state per poll of its job.

const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOM_HEX = "#2F6B4F";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// ---------------------------------------------------------------------------
// A real PNG, made here: 1600 by 1200, a flat backdrop with a darker block.
// Large enough for every default channel, a few kilobytes on disk.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function productPhotoPng(width = 1600, height = 1200): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inProduct = x > width * 0.35 && x < width * 0.65 && y > height * 0.2 && y < height * 0.8;
      const [r, g, b] = inProduct ? [100, 112, 140] : [234, 223, 207];
      const at = y * row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PHOTO = productPhotoPng();

// ---------------------------------------------------------------------------

async function openFormWithPhoto(page: Page, name: string) {
  // The demo server is shared by every spec, so another test's pack can
  // finish here and raise its notice over the phone bar: dismiss it.
  await page.addLocatorHandler(
    page.getByTestId("pack-ready-notice").first(),
    async () => {
      const dismiss = page.getByTestId("pack-ready-notice").getByRole("button", { name: "Dismiss" });
      while ((await dismiss.count()) > 0) await dismiss.first().click();
    },
    { noWaitAfter: true },
  );
  await page.route("**/api/uploads/sign", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://r2.e2e.invalid/upload", key: `ws/${DEMO_WORKSPACE_ID}/src/${name}` }),
    }),
  );
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  await page.route("https://r2.e2e.invalid/upload", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, body: "" }),
  );
  await page.goto("/app/new");
  await expect(page.getByTestId("output-options")).toBeVisible();
  await page.getByLabel("Upload a product photo").setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: PHOTO });
  await expect(page.getByTestId("upload-done")).toBeVisible();
  await expect(page.getByTestId("preflight-ready")).toBeVisible();
}

/** The phone bar's "About N credits" as a number. */
async function barTotal(page: Page): Promise<number> {
  const text = await page.getByTestId("bar-total").innerText();
  const match = /(\d+)/.exec(text);
  expect(match, `bar total "${text}"`).not.toBeNull();
  return Number(match?.[1]);
}

/** Only the preview strip may scroll sideways; the page never does. */
async function expectNoSidewaysScroll(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function expectBarVisible(page: Page) {
  await expect(page.getByTestId("summary-bar")).toBeInViewport();
  await expect(page.getByTestId("create-pack-bar")).toBeInViewport();
}

function channelBox(page: Page, specId: string): Locator {
  return page.getByTestId(`channel-${specId}`).getByRole("checkbox");
}

async function createPack(page: Page) {
  const create = page.getByTestId("create-pack-bar");
  await expect(create).toBeEnabled();
  await create.click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45000 });
}

/** The inline SVG a demo shot preview draws, decoded. */
async function previewSvg(card: Locator): Promise<string> {
  const src = await card.getByTestId("shot-preview").locator("img").getAttribute("src");
  expect(src).toMatch(/^data:image\/svg\+xml/);
  return decodeURIComponent((src ?? "").split(",").slice(1).join(","));
}

/** The first rect of a demo preview is its background. */
function backgroundFill(svg: string): string | null {
  return /<rect [^>]*fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1]?.toUpperCase() ?? null;
}

test("Keep my photo on a phone: heads up, custom color, the job page and the report", async ({ page }) => {
  await openFormWithPhoto(page, "e2e-keep");
  await expectBarVisible(page);
  await expectNoSidewaysScroll(page);
  const before = await barTotal(page);

  // 1. Keep my photo.
  await page.getByTestId("look-keep_photo").tap();
  await expect(page.getByTestId("look-keep_photo")).toHaveAttribute("aria-checked", "true");
  const removeSwitch = page.getByTestId("remove-background");
  await expect(removeSwitch).toHaveAttribute("aria-checked", "false");

  // 2. The Amazon main heads up appears and the estimate drops.
  const amazonHeadsUp = page.getByTestId("channel-amazon.main").getByTestId("row-heads-up");
  await expect(amazonHeadsUp).toContainText("Amazon's main image must be pure white");
  await expect.poll(() => barTotal(page)).toBeLessThan(before);
  await expectNoSidewaysScroll(page);

  // Throughout: Leave it out unticks the channel (ticked again for the pack).
  await expect(channelBox(page, "amazon.main")).toBeChecked();
  await amazonHeadsUp.getByRole("button", { name: "Leave it out" }).click();
  await expect(channelBox(page, "amazon.main")).not.toBeChecked();
  await expect(amazonHeadsUp).toHaveCount(0);
  await channelBox(page, "amazon.main").click();
  await expect(channelBox(page, "amazon.main")).toBeChecked();
  await expect(amazonHeadsUp).toBeVisible();

  // Throughout: the Switch toggles by keyboard.
  await removeSwitch.focus();
  await page.keyboard.press("Space");
  await expect(removeSwitch).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(removeSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("look-keep_photo")).toHaveAttribute("aria-checked", "true");

  // 3. A custom color with a typed hex, then create the pack.
  await page.getByTestId("color-select").selectOption("custom");
  const hex = page.getByTestId("custom-hex");
  await expect(hex).toBeVisible();
  await hex.fill(CUSTOM_HEX);
  // The bar steps aside while a text field has focus, then comes back.
  await expect(page.getByTestId("summary-bar")).toBeHidden();
  await hex.blur();
  await expect(page.getByTestId("color-chip")).toContainText(CUSTOM_HEX);
  await expectBarVisible(page);
  await expectNoSidewaysScroll(page);

  const request = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await page.getByTestId("create-pack-bar").click();
  const body = (await request).postDataJSON() as {
    channels: string[];
    outputOptions?: { background?: string; color?: { kind: string; hex?: string } };
  };
  expect(body.channels).toContain("amazon.main");
  expect(body.outputOptions?.background).toBe("keep");
  expect(body.outputOptions?.color).toEqual({ kind: "custom", hex: CUSTOM_HEX });
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  await expect(page.getByTestId("job-status")).toHaveText("Done", { timeout: 45000 });
  await expectNoSidewaysScroll(page);

  // 4. Your choices, the kept photos uncropped in their own shape, and a white Amazon main.
  await expect(page.getByTestId("job-options-card")).toBeVisible();
  await expect(page.getByTestId("job-options-look")).toHaveText(/Keep my photo|Custom/);
  await expect(page.getByTestId("job-options-card")).toContainText("Background kept as you took it");
  await expect(page.getByTestId("job-options-card")).toContainText(`Added space`);

  const originals = page.locator('[data-testid="shot-card"][data-shot-type="original_photo"]');
  expect(await originals.count()).toBeGreaterThan(0);
  for (const card of await originals.all()) {
    const preview = card.getByTestId("shot-preview");
    await preview.scrollIntoViewIfNeeded();
    const img = preview.locator("img");
    await expect(img).toHaveJSProperty("complete", true);
    const fit = await img.evaluate((el: HTMLImageElement) => {
      const box = el.getBoundingClientRect();
      const frame = (el.parentElement as HTMLElement).getBoundingClientRect();
      return {
        natural: el.naturalWidth / el.naturalHeight,
        shown: box.width / box.height,
        inside:
          box.left >= frame.left - 0.5 &&
          box.right <= frame.right + 0.5 &&
          box.top >= frame.top - 0.5 &&
          box.bottom <= frame.bottom + 0.5,
      };
    });
    expect(fit.inside).toBe(true);
    expect(Math.abs(fit.shown - fit.natural)).toBeLessThan(0.02);
    // The seller's own photo, never a flat studio color.
    expect(await previewSvg(card)).toContain("original photo");
  }

  const amazonMain = page.locator('[data-testid="shot-card"][data-shot-type="amazon_main"]');
  await expect(amazonMain).toHaveCount(1);
  expect(backgroundFill(await previewSvg(amazonMain))).toBe("#FFFFFF");

  // 5. The report says the background was kept and space was added in the color.
  const report = page.getByTestId("compliance-report");
  await expect(report).toBeVisible();
  await expect(report).toContainText("Your photo, kept as you took it. Nothing in it was redrawn.");
  await expect(report).toContainText(`Space added around your photo in ${CUSTOM_HEX}`);
  await expect(report).toContainText("This channel needs a pure white background, so the background was removed for this file only.");
});

test("Remove on Sand keeps the Amazon main white", async ({ page }) => {
  await openFormWithPhoto(page, "e2e-sand");

  // 6. Sand with Remove.
  const removeSwitch = page.getByTestId("remove-background");
  await expect(removeSwitch).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("color-select").selectOption("swatch:sand");
  await expect(page.getByTestId("color-chip")).toContainText("Sand");
  await expect(page.getByTestId("heads-up-white_required")).toContainText("Amazon main image stays pure white");
  await expectBarVisible(page);
  await expectNoSidewaysScroll(page);

  await createPack(page);
  await expect(page.getByTestId("job-options-card")).toContainText(/Background removed, on sand/i);
  await expect(page.getByTestId("job-options-card")).toContainText("pure white, because Amazon requires white");

  const amazonMain = page.locator('[data-testid="shot-card"][data-shot-type="amazon_main"]');
  await expect(amazonMain).toHaveCount(1);
  expect(backgroundFill(await previewSvg(amazonMain))).toBe("#FFFFFF");

  const report = page.getByTestId("compliance-report");
  const amazonFile = report
    .getByTestId("compliance-file")
    .filter({ hasText: "This channel needs pure white, so this file uses white instead of your color." });
  await expect(amazonFile).toHaveCount(1);
  await expect(amazonFile).toContainText("Amazon");
});
