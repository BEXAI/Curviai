import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { stillStyle } from "../seed/templates";
import { hexToRgb } from "../color";
import { boundingBoxOfMask } from "../mask";
import { decodeMask, decodeToRgba, type RawImage, type RawMask } from "../raw";
import { fidelityReport } from "../qc/fidelity";
import { pixelChecks, qcKindForSpec } from "../qc/pixelChecks";
import { rectProduct } from "../testutil";
import { loadTemplateFont, resolveTemplateFontFile } from "./font";
import {
  renderTemplateStill,
  sanitizeCallout,
  TEMPLATE_STILL_TYPES,
  TEXT_TEMPLATE_TYPES,
  TemplateUnavailableError,
  type TemplateStillType,
} from "./still";

const PRODUCT_RGB = { r: 30, g: 110, b: 170 };

/** RGBA cutout plus mask, both the same size, alpha 0 outside the product. */
async function syntheticCutout(): Promise<{ productPng: Buffer; maskPng: Buffer }> {
  const product = await rectProduct(256, `rgb(${PRODUCT_RGB.r},${PRODUCT_RGB.g},${PRODUCT_RGB.b})`);
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

/**
 * Textured cutout (gradients plus seeded noise inside an ellipse, alpha 0
 * outside), so the rule 3 check compares real detail, not one flat color.
 */
async function texturedCutout(size = 256): Promise<{ productPng: Buffer; maskPng: Buffer }> {
  const data = Buffer.alloc(size * size * 4, 0);
  const maskData = Buffer.alloc(size * size, 0);
  let seed = 424242;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 31) - 15;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - size / 2) / (size * 0.3);
      const dy = (y + 0.5 - size / 2) / (size * 0.42);
      if (dx * dx + dy * dy > 1) continue;
      const o = (y * size + x) * 4;
      data[o] = Math.round(70 + (110 * x) / size + noise());
      data[o + 1] = Math.round(60 + (120 * y) / size + noise());
      data[o + 2] = Math.round(160 - (70 * (x + y)) / (2 * size) + noise());
      data[o + 3] = 255;
      maskData[y * size + x] = 255;
    }
  }
  const productPng = await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const maskPng = await sharp(maskData, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
  return { productPng, maskPng };
}

/** Copy of image with red raised by amount inside mask, like a stray tint. */
function tintInsideMask(image: RawImage, mask: RawMask, amount: number): RawImage {
  const data = Buffer.from(image.data);
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) continue;
    data[i * 4] = Math.min(255, data[i * 4] + amount);
  }
  return { ...image, data };
}

const colors = {
  backgroundHex: stillStyle.defaultBackgroundHex,
  textHex: stillStyle.textHex,
  accentHex: stillStyle.accentHex,
};

const cases: { type: TemplateStillType; specId: string; callouts?: string[]; headline?: string }[] = [
  {
    type: "infographic",
    specId: "amazon.secondary",
    callouts: ["Keeps drinks cold for 24 hours", "Leak proof lid", "Dishwasher safe", "BPA free steel"],
  },
  { type: "dimensions", specId: "amazon.secondary", callouts: ["12 x 8 x 4 in"] },
  {
    type: "in_the_box",
    specId: "amazon.secondary",
    callouts: ["Bottle", "Bamboo lid", "Cleaning brush", "Carry strap"],
  },
  {
    type: "comparison",
    specId: "amazon.secondary",
    callouts: ["Holds 24 oz, most hold 16 oz", "Cold for 24 hours, not 12"],
  },
  { type: "aplus_banner", specId: "amazon.aplus.basic_header" },
  // The six A+ modules (PHASE_16 workstream 2): a rule 3 check for each.
  {
    type: "aplus_features",
    specId: "amazon.aplus.basic_header",
    headline: "Built for everyday use",
    callouts: ["Leak proof lid", "Dishwasher safe", "Fits cup holders"],
  },
  {
    type: "aplus_pain_points",
    specId: "amazon.aplus.basic_header",
    headline: "No more warm water",
    callouts: ["Stays cold on hot days", "No drips in your bag", "Easy to carry all day"],
  },
  {
    type: "aplus_ingredients",
    specId: "amazon.aplus.basic_header",
    headline: "What it is made of",
    callouts: ["Stainless steel", "Bamboo lid"],
  },
  {
    type: "aplus_results",
    specId: "amazon.aplus.basic_header",
    headline: "What daily use looks like",
    callouts: ["Cold water at your desk", "Fewer plastic bottles", "A lid that stays shut"],
  },
  {
    type: "aplus_how_to",
    specId: "amazon.aplus.basic_header",
    headline: "How to use it",
    callouts: ["Fill with water", "Twist the lid shut", "Rinse after use"],
  },
  {
    type: "aplus_endorsement",
    specId: "amazon.aplus.basic_header",
    callouts: ["Loved by hikers", "Gift Guide pick 2026"],
  },
  { type: "social_1x1", specId: "meta.feed_1x1" },
  { type: "social_4x5", specId: "meta.feed_4x5" },
  { type: "social_9x16", specId: "meta.story_9x16" },
  { type: "social_2x3", specId: "pinterest.pin" },
];

function nearColor(data: Buffer, o: number, c: { r: number; g: number; b: number }, tol: number): boolean {
  return (
    Math.abs(data[o] - c.r) <= tol && Math.abs(data[o + 1] - c.g) <= tol && Math.abs(data[o + 2] - c.b) <= tol
  );
}

describe("renderTemplateStill", () => {
  it("lists every template type", () => {
    for (const c of cases) {
      expect(TEMPLATE_STILL_TYPES.has(c.type)).toBe(true);
    }
    expect(TEMPLATE_STILL_TYPES.has("lifestyle")).toBe(false);
  });

  it("marks the list templates as text templates", () => {
    for (const type of ["infographic", "dimensions", "in_the_box", "comparison"]) {
      expect(TEXT_TEMPLATE_TYPES.has(type)).toBe(true);
    }
    expect(TEXT_TEMPLATE_TYPES.has("social_1x1")).toBe(false);
  });

  for (const c of cases) {
    it(`renders ${c.type} for ${c.specId} within the channel spec`, async () => {
      const spec = getSpec(c.specId);
      const cutout = await syntheticCutout();
      const result = await renderTemplateStill({
        type: c.type,
        spec,
        ...cutout,
        callouts: c.callouts,
        ...(c.headline ? { headline: c.headline } : {}),
        ...colors,
      });
      const { image, mask, encoded } = result;

      // Size, format and bytes.
      expect(image.width).toBe(spec.width);
      expect(image.height).toBe(spec.height);
      expect(mask.width).toBe(image.width);
      expect(mask.height).toBe(image.height);
      expect(spec.formats).toContain(encoded.format);
      expect(encoded.format).toBe("jpg");
      if (spec.maxBytes) {
        expect(encoded.buffer.length).toBeLessThanOrEqual(spec.maxBytes);
      }
      const meta = await sharp(encoded.buffer).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(spec.width);
      expect(meta.height).toBe(spec.height);

      // image is exactly the decoded file.
      const decoded = await decodeToRgba(encoded.buffer);
      expect(decoded.data.equals(image.data)).toBe(true);

      const report = await pixelChecks(image, mask, spec, {
        encoded: { bytes: encoded.buffer.length, format: encoded.format },
        edgeMarginPx: 2,
      });
      expect(report.checks.filter((k) => !k.pass)).toEqual([]);
      expect(report.pass).toBe(true);

      // Product pixels are the scaled product, not regenerated.
      const bbox = boundingBoxOfMask(mask);
      expect(bbox).not.toBeNull();
      const cx = bbox!.left + Math.floor(bbox!.width / 2);
      const cy = bbox!.top + Math.floor(bbox!.height / 2);
      expect(nearColor(image.data, (cy * image.width + cx) * 4, PRODUCT_RGB, 3)).toBe(true);
      // Product keeps its aspect (the synthetic rect is 0.4 by 0.5).
      expect(bbox!.width / bbox!.height).toBeCloseTo(0.8, 1);

      // Text and lines appear outside the product only for the text templates.
      const text = hexToRgb(colors.textHex);
      const accent = hexToRgb(colors.accentHex);
      let textPixels = 0;
      let accentPixels = 0;
      for (let i = 0; i < mask.data.length; i++) {
        if (mask.data[i] !== 0) continue;
        if (nearColor(image.data, i * 4, text, 24)) textPixels++;
        if (nearColor(image.data, i * 4, accent, 24)) accentPixels++;
      }
      if (TEXT_TEMPLATE_TYPES.has(c.type)) {
        expect(textPixels).toBeGreaterThan(200);
        expect(accentPixels).toBeGreaterThan(50);
      } else {
        expect(textPixels).toBe(0);
        expect(accentPixels).toBe(0);
      }

      // Background stays the caller's color away from product and text.
      const bg = hexToRgb(colors.backgroundHex);
      expect(nearColor(image.data, (2 * image.width + 2) * 4, bg, 3)).toBe(true);
    });
  }

  it("keeps the 9x16 product out of the story safe zones", async () => {
    const spec = getSpec("meta.story_9x16");
    const result = await renderTemplateStill({ type: "social_9x16", spec, ...(await syntheticCutout()), ...colors });
    const bbox = boundingBoxOfMask(result.mask)!;
    expect(bbox.top).toBeGreaterThanOrEqual(spec.safeZone!.top);
    expect(bbox.top + bbox.height).toBeLessThanOrEqual(spec.height! - spec.safeZone!.bottom);
  });

  it("stacks infographic callouts below the product on a portrait canvas", async () => {
    const spec = getSpec("meta.feed_4x5");
    const result = await renderTemplateStill({
      type: "infographic",
      spec,
      ...(await syntheticCutout()),
      callouts: ["Leak proof lid", "Dishwasher safe", "Fits cup holders"],
      ...colors,
    });
    const report = await pixelChecks(result.image, result.mask, spec, {
      encoded: { bytes: result.encoded.buffer.length, format: result.encoded.format },
      edgeMarginPx: 2,
    });
    expect(report.pass).toBe(true);
  });

  it("throws TemplateUnavailableError for an infographic with no usable callouts", async () => {
    const cutout = await syntheticCutout();
    const spec = getSpec("amazon.secondary");
    await expect(renderTemplateStill({ type: "infographic", spec, ...cutout, callouts: [], ...colors })).rejects.toBeInstanceOf(
      TemplateUnavailableError,
    );
    await expect(
      renderTemplateStill({ type: "infographic", spec, ...cutout, callouts: ["  ", "\u{1F680}", " - "], ...colors }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
    await expect(renderTemplateStill({ type: "infographic", spec, ...cutout, ...colors })).rejects.toBeInstanceOf(
      TemplateUnavailableError,
    );
  });

  it("throws TemplateUnavailableError for in the box and comparison with no seller lines", async () => {
    const cutout = await syntheticCutout();
    const spec = getSpec("amazon.secondary");
    for (const type of ["in_the_box", "comparison"] as const) {
      await expect(renderTemplateStill({ type, spec, ...cutout, ...colors })).rejects.toBeInstanceOf(
        TemplateUnavailableError,
      );
      await expect(renderTemplateStill({ type, spec, ...cutout, callouts: [" "], ...colors })).rejects.toBeInstanceOf(
        TemplateUnavailableError,
      );
    }
  });

  it("never pads an A+ module: fewer usable lines than the seeded minimum is refused", async () => {
    const spec = getSpec("amazon.aplus.basic_header");
    const cutout = await syntheticCutout();
    await expect(
      renderTemplateStill({
        type: "aplus_features",
        spec,
        ...cutout,
        headline: "Built for everyday use",
        callouts: ["Leak proof lid", "  "],
        ...colors,
      }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
    await expect(
      renderTemplateStill({ type: "aplus_endorsement", spec, ...cutout, callouts: [], ...colors }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
  });

  it("prints an A+ module headline above its lines, clear of the product", async () => {
    const spec = getSpec("amazon.aplus.basic_header");
    const cutout = await syntheticCutout();
    const base = { type: "aplus_how_to" as const, spec, ...cutout, callouts: ["Fill it", "Close it", "Carry it"], ...colors };
    const without = await renderTemplateStill(base);
    const withHeadline = await renderTemplateStill({ ...base, headline: "How to use it" });
    const text = hexToRgb(colors.textHex);
    const count = (r: typeof without) => {
      let n = 0;
      for (let i = 0; i < r.mask.data.length; i++) {
        if (r.mask.data[i] === 0 && nearColor(r.image.data, i * 4, text, 24)) n++;
      }
      return n;
    };
    expect(count(withHeadline)).toBeGreaterThan(count(without) + 200);
    // The product is placed the same way with or without the headline.
    expect(boundingBoxOfMask(withHeadline.mask)).toEqual(boundingBoxOfMask(without.mask));
  });

  it("throws TemplateUnavailableError for dimensions with no label", async () => {
    const cutout = await syntheticCutout();
    await expect(
      renderTemplateStill({ type: "dimensions", spec: getSpec("amazon.secondary"), ...cutout, callouts: [], ...colors }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
  });

  it("refuses text templates on channels that forbid text", async () => {
    const cutout = await syntheticCutout();
    await expect(
      renderTemplateStill({
        type: "infographic",
        spec: getSpec("google.merchant.lifestyle"),
        ...cutout,
        callouts: ["Leak proof lid"],
        ...colors,
      }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
  });

  it("renders messy callouts without clipping and steps quality down under a tight byte cap", async () => {
    const spec: ChannelSpec = {
      id: "test.tight",
      verified: false,
      width: 800,
      height: 800,
      formats: ["jpg"],
      maxBytes: 120_000,
      textAllowed: true,
    };
    const result = await renderTemplateStill({
      type: "infographic",
      spec,
      ...(await syntheticCutout()),
      callouts: [
        "Fast charge → full in 30 min \u{1F50B}",
        "Works with <any> phone & tablet — really",
        "Supercalifragilisticexpialidociousness!!",
        "A very long callout that goes well past the forty character cap",
        "-> Travel ready",
        "Sixth callout is dropped",
      ],
      ...colors,
    });
    expect(result.encoded.buffer.length).toBeLessThanOrEqual(spec.maxBytes!);
    const report = await pixelChecks(result.image, result.mask, spec, {
      encoded: { bytes: result.encoded.buffer.length, format: result.encoded.format },
      edgeMarginPx: 2,
    });
    expect(report.pass).toBe(true);
  });
});

describe("renderTemplateStill rule 3 product fidelity", () => {
  for (const c of cases) {
    it(`${c.type} for ${c.specId}: shipped product pixels match the placed cutout`, async () => {
      const spec = getSpec(c.specId);
      const render = await renderTemplateStill({
        type: c.type,
        spec,
        ...(await texturedCutout()),
        callouts: c.callouts,
        ...(c.headline ? { headline: c.headline } : {}),
        ...colors,
      });
      expect(render.productReference.width).toBe(render.image.width);
      expect(render.productReference.height).toBe(render.image.height);
      expect(spec.formats).toContain(render.encoded.format);
      const decoded = await decodeToRgba(render.encoded.buffer);
      expect(decoded.data.equals(render.image.data)).toBe(true);

      const kind = qcKindForSpec(spec);
      const report = await fidelityReport(render.productReference, render.image, render.mask, { kind });
      expect(report.issues).toEqual([]);
      expect(report.pass).toBe(true);
      expect(report.maskArea).toBeGreaterThan(1000);

      // The check bites: a slight tint inside the product fails it.
      const tinted = await fidelityReport(
        render.productReference,
        tintInsideMask(render.image, render.mask, 25),
        render.mask,
        { kind },
      );
      expect(tinted.pass).toBe(false);
    });
  }
});

describe("sanitizeCallout", () => {
  it("drops Unicode dashes and minus signs used as punctuation", () => {
    expect(sanitizeCallout("Fast \u2010 easy")).toBe("Fast easy");
    expect(sanitizeCallout("Fast \u2011 easy")).toBe("Fast easy");
    expect(sanitizeCallout("Fast\u2012easy")).toBe("Fast easy");
    expect(sanitizeCallout("Fast \u2013 easy")).toBe("Fast easy");
    expect(sanitizeCallout("Fast\u2014easy")).toBe("Fast easy");
    expect(sanitizeCallout("Fast \u2212 easy")).toBe("Fast easy");
    expect(sanitizeCallout("\u2212 Travel ready")).toBe("Travel ready");
    expect(sanitizeCallout("Travel ready \u2010")).toBe("Travel ready");
  });

  it("drops doubled ASCII hyphens used as punctuation", () => {
    expect(sanitizeCallout("fast--easy")).toBe("fast easy");
    expect(sanitizeCallout("fast -- easy")).toBe("fast easy");
    expect(sanitizeCallout("fast---easy")).toBe("fast easy");
    expect(sanitizeCallout("-- Leak proof")).toBe("Leak proof");
  });

  it("keeps hyphens inside words", () => {
    expect(sanitizeCallout("12-inch pan")).toBe("12-inch pan");
    expect(sanitizeCallout("Dishwasher-safe lid")).toBe("Dishwasher-safe lid");
    expect(sanitizeCallout("12\u2010inch pan")).toBe("12-inch pan");
    expect(sanitizeCallout("Non\u2011stick 12-inch pan")).toBe("Non-stick 12-inch pan");
  });

  it("never leaves a dash character in the output", () => {
    const inputs = [
      "Fast \u2010 easy",
      "a\u2012b \u2212 c",
      "fast--easy -- done",
      "x \u2015 y \u2E3A z \uFE58 w \uFF0D v",
      "- lead and trail -",
    ];
    for (const input of inputs) {
      const out = sanitizeCallout(input);
      expect(out).not.toMatch(/[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/u);
      expect(out).not.toMatch(/--|(^|\s)-|-(\s|$)/);
    }
  });
});

describe("resolveTemplateFontFile", () => {
  it("resolves the bundled Inter TTF", () => {
    const file = resolveTemplateFontFile();
    expect(file).not.toBeNull();
    expect(file!.endsWith(".ttf")).toBe(true);
    expect(existsSync(file!)).toBe(true);
    expect(statSync(file!).size).toBeGreaterThan(50_000);
  });

  it("parses the bundled font as Inter with Latin glyphs", () => {
    const font = loadTemplateFont();
    expect(font).not.toBeNull();
    expect(font!.names.fontFamily.en).toMatch(/^Inter/);
    for (const ch of "Aa0x&") {
      expect(font!.charToGlyphIndex(ch)).toBeGreaterThan(0);
    }
  });
});
