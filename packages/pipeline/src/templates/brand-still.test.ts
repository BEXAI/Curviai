import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec } from "@curvi/specs";
import { stillStyle } from "../seed/templates";
import { DEFAULT_TEMPLATE_FONT, templateFonts, type TemplateFontKey } from "../seed/fonts";
import { boundingBoxOfMask } from "../mask";
import { decodeMask, decodeToRgba, type RawImage } from "../raw";
import { fidelityReport } from "../qc/fidelity";
import { qcKindForSpec } from "../qc/pixelChecks";
import { rectProduct } from "../testutil";
import { loadBrandTemplateFont, loadTemplateFont, resolveFontFile } from "./font";
import { renderTemplateStill, type TemplateStillType } from "./still";

// A pure red logo: no template background, text or product color comes near
// it, so its pixels can be counted on the canvas.
const LOGO_RGB = { r: 230, g: 20, b: 20 };

async function logoPng(width = 400, height = 160): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { ...LOGO_RGB, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

async function cutout(): Promise<{ productPng: Buffer; maskPng: Buffer }> {
  const product = await rectProduct(256, "rgb(30,110,170)");
  const rgba = await decodeToRgba(product.source);
  const mask = await decodeMask(product.mask);
  for (let i = 0; i < mask.data.length; i++) {
    rgba.data[i * 4 + 3] = mask.data[i];
  }
  const productPng = await sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .png()
    .toBuffer();
  return { productPng, maskPng: product.mask };
}

const colors = {
  backgroundHex: stillStyle.defaultBackgroundHex,
  textHex: stillStyle.textHex,
  accentHex: stillStyle.accentHex,
};

const CALLOUTS = ["Keeps drinks cold for 24 hours", "Leak proof lid", "Dishwasher safe"];

/** Pixels close to the logo color: where they are and how many. */
function logoPixels(image: RawImage): { count: number; box: { left: number; top: number; right: number; bottom: number } } {
  let count = 0;
  const box = { left: image.width, top: image.height, right: -1, bottom: -1 };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      const d = image.data;
      if (Math.abs(d[o] - LOGO_RGB.r) < 30 && Math.abs(d[o + 1] - LOGO_RGB.g) < 30 && Math.abs(d[o + 2] - LOGO_RGB.b) < 30) {
        count++;
        box.left = Math.min(box.left, x);
        box.top = Math.min(box.top, y);
        box.right = Math.max(box.right, x);
        box.bottom = Math.max(box.bottom, y);
      }
    }
  }
  return { count, box };
}

describe("brand template fonts", () => {
  it("ships every catalog font as a parseable TTF", () => {
    for (const key of Object.keys(templateFonts) as TemplateFontKey[]) {
      const file = resolveFontFile(key);
      expect(file, key).not.toBeNull();
      expect(existsSync(file!)).toBe(true);
      expect(loadBrandTemplateFont(key), key).not.toBeNull();
    }
  });

  it("loads the picked font and falls back to the default for empty or unknown keys", () => {
    const playfair = loadBrandTemplateFont("playfair_display");
    expect(playfair!.names.fontFamily.en).toMatch(/Playfair/);
    expect(loadBrandTemplateFont("")).toBe(loadTemplateFont());
    expect(loadBrandTemplateFont("comic_sans")).toBe(loadTemplateFont());
    expect(loadBrandTemplateFont(null)).toBe(loadTemplateFont());
    expect(DEFAULT_TEMPLATE_FONT).toBe("inter");
  });

  it("renders infographic callouts in the body font, so the text differs from the default", async () => {
    const spec = getSpec("amazon.secondary");
    const input = { type: "infographic" as const, spec, ...(await cutout()), callouts: CALLOUTS, ...colors };
    const plain = await renderTemplateStill(input);
    const branded = await renderTemplateStill({ ...input, fonts: { body: "playfair_display" } });
    expect(branded.image.data.equals(plain.image.data)).toBe(false);
    // The heading font does not touch infographic callouts.
    const headingOnly = await renderTemplateStill({ ...input, fonts: { heading: "playfair_display" } });
    expect(headingOnly.image.data.equals(plain.image.data)).toBe(true);
  });

  it("renders the dimensions label in the heading font", async () => {
    const spec = getSpec("amazon.secondary");
    const input = { type: "dimensions" as const, spec, ...(await cutout()), callouts: ["12 x 8 x 4 in"], ...colors };
    const plain = await renderTemplateStill(input);
    const branded = await renderTemplateStill({ ...input, fonts: { heading: "roboto_slab" } });
    expect(branded.image.data.equals(plain.image.data)).toBe(false);
  });
});

describe("brand logo on template stills", () => {
  const logoTypes: { type: TemplateStillType; specId: string; callouts?: string[] }[] = [
    { type: "infographic", specId: "amazon.secondary", callouts: CALLOUTS },
    { type: "social_1x1", specId: "meta.feed_1x1" },
    { type: "social_4x5", specId: "meta.feed_4x5" },
    { type: "social_9x16", specId: "meta.story_9x16" },
    { type: "social_2x3", specId: "pinterest.pin" },
  ];

  for (const c of logoTypes) {
    it(`${c.type}: places the logo clear of the product and keeps rule 3`, async () => {
      const spec = getSpec(c.specId);
      const render = await renderTemplateStill({
        type: c.type,
        spec,
        ...(await cutout()),
        callouts: c.callouts,
        ...colors,
        logo: await logoPng(),
      });
      expect(render.logoPlaced).toBe(true);
      const logo = logoPixels(render.image);
      expect(logo.count).toBeGreaterThan(100);

      // Never over the product: no logo pixel inside the product box.
      const product = boundingBoxOfMask(render.mask)!;
      const overlaps =
        logo.box.left < product.left + product.width &&
        product.left <= logo.box.right &&
        logo.box.top < product.top + product.height &&
        product.top <= logo.box.bottom;
      expect(overlaps).toBe(false);

      // Within the size cap: at most 26 percent of the short side wide.
      const short = Math.min(render.image.width, render.image.height);
      expect(logo.box.right - logo.box.left + 1).toBeLessThanOrEqual(Math.round(short * 0.26));

      const report = await fidelityReport(render.productReference, render.image, render.mask, {
        kind: qcKindForSpec(spec),
      });
      expect(report.pass).toBe(true);
    });
  }

  it("never draws the logo on dimensions or A+ banner stills", async () => {
    for (const c of [
      { type: "dimensions" as const, specId: "amazon.secondary", callouts: ["12 x 8 x 4 in"] },
      { type: "aplus_banner" as const, specId: "amazon.aplus.basic_header" },
    ]) {
      const render = await renderTemplateStill({
        type: c.type,
        spec: getSpec(c.specId),
        ...(await cutout()),
        callouts: c.callouts,
        ...colors,
        logo: await logoPng(),
      });
      expect(render.logoPlaced, c.type).toBe(false);
      expect(logoPixels(render.image).count, c.type).toBe(0);
    }
  });

  it("skips a logo that cannot be decoded instead of failing the still", async () => {
    const render = await renderTemplateStill({
      type: "social_1x1",
      spec: getSpec("meta.feed_1x1"),
      ...(await cutout()),
      ...colors,
      logo: Buffer.from("not an image"),
    });
    expect(render.logoPlaced).toBe(false);
    expect(render.image.width).toBeGreaterThan(0);
  });

  it("renders the same still with no logo as before", async () => {
    const spec = getSpec("meta.feed_1x1");
    const base = { type: "social_1x1" as const, spec, ...(await cutout()), ...colors };
    const plain = await renderTemplateStill(base);
    const nullLogo = await renderTemplateStill({ ...base, logo: null });
    expect(nullLogo.image.data.equals(plain.image.data)).toBe(true);
    expect(plain.logoPlaced).toBe(false);
  });
});
