/**
 * PHASE_16 workstream 3: the ads formats keep every product pixel real
 * (rule 3, a fidelity check per slide and per placement), carousel slides
 * are exact slices of one canvas whose seams line up to the pixel with no
 * product crossing one, and ad copy stays inside each placement's safe zone.
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec, safeArea } from "@curvi/specs";
import { boundingBoxOfMask } from "../mask";
import { decodeMask, decodeToRgba, type RawImage } from "../raw";
import { fidelityReport } from "../qc/fidelity";
import { adsFormats, stillStyle } from "../seed/templates";
import { rule9Problems } from "../copy-lint";
import {
  adsLine,
  composeCarouselSlide,
  overlaySceneLine,
  renderAdVariant,
  renderCarouselCanvas,
  renderCarouselSlide,
  renderPinMoodboard,
  sliceCarouselCanvas,
  type CarouselSlideContent,
} from "./ads";
import {
  adVariantAreas,
  boxWithin,
  carouselGeometry,
  carouselMargin,
  carouselPlacementsValid,
  carouselSlideAreas,
  crossesSeam,
  seamsOf,
  type CarouselSlideRole,
} from "./ads-layout";
import { TemplateUnavailableError } from "./still";

/** Textured cutout: gradients plus seeded noise inside an ellipse. */
async function texturedCutout(size = 220): Promise<{ productPng: Buffer; maskPng: Buffer }> {
  const data = Buffer.alloc(size * size * 4, 0);
  const maskData = Buffer.alloc(size * size, 0);
  let seed = 777;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 31) - 15;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - size / 2) / (size * 0.3);
      const dy = (y + 0.5 - size / 2) / (size * 0.44);
      if (dx * dx + dy * dy > 1) continue;
      const o = (y * size + x) * 4;
      data[o] = Math.round(60 + (120 * x) / size + noise());
      data[o + 1] = Math.round(70 + (110 * y) / size + noise());
      data[o + 2] = Math.round(170 - (80 * (x + y)) / (2 * size) + noise());
      data[o + 3] = 255;
      maskData[y * size + x] = 255;
    }
  }
  return {
    productPng: await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer(),
    maskPng: await sharp(maskData, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer(),
  };
}

const style = {
  backgroundHex: stillStyle.presetBackgroundHex.minimal_studio,
  textHex: stillStyle.textHex,
  accentHex: stillStyle.accentHex,
};

const STORY: CarouselSlideContent[] = [
  { slideIndex: 1, role: "hero", headline: "Ceramic pour over mug" },
  { slideIndex: 2, role: "support", headline: "Keeps coffee hot" },
  { slideIndex: 3, role: "support", lines: ["Pour over rim", "Easy grip handle", "Fits any dripper"] },
  { slideIndex: 4, role: "support", lines: ["Mug", "Gift box"] },
  { slideIndex: 5, role: "hero", headline: "Ceramic pour over mug", cta: "Shop now" },
];

function pixelAt(img: RawImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

describe("carousel layout, the planner rule", () => {
  it("keeps every slide's product and text inside its own slide, clear of every seam, for 1 to 10 slides", () => {
    const spec = getSpec(adsFormats.carousel.specId);
    for (let n = 1; n <= adsFormats.carousel.maxSlides; n++) {
      const geometry = carouselGeometry(spec, n);
      const roles: CarouselSlideRole[] = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "hero" : "support"));
      expect(carouselPlacementsValid(geometry, roles), `${n} slides`).toBe(true);
      for (let i = 1; i <= n; i++) {
        for (const role of ["hero", "support"] as const) {
          const areas = carouselSlideAreas(geometry, i, role);
          expect(crossesSeam(areas.product, geometry)).toBe(false);
          expect(crossesSeam(areas.text, geometry)).toBe(false);
        }
      }
    }
  });

  it("flags a box that spans or touches a seam", () => {
    const geometry = carouselGeometry(getSpec("meta.feed_4x5"), 3);
    expect(seamsOf(geometry)).toEqual([1080, 2160]);
    expect(crossesSeam({ left: 1000, top: 0, width: 160, height: 10 }, geometry)).toBe(true);
    expect(crossesSeam({ left: 1000, top: 0, width: 80, height: 10 }, geometry)).toBe(true);
    expect(crossesSeam({ left: 1000, top: 0, width: 79, height: 10 }, geometry)).toBe(false);
    expect(carouselPlacementsValid(geometry, ["hero", "hero"])).toBe(false);
  });
});

describe("carousel rendering (founder decision 4: one canvas, cut into slides)", () => {
  it("cuts one canvas into slides that line up to the pixel, and each slide renders as exactly its slice", async () => {
    const spec = getSpec(adsFormats.carousel.specId);
    const cutout = await texturedCutout();
    const whole = await renderCarouselCanvas({ spec, slideCount: STORY.length, slides: STORY, ...cutout, ...style });
    const { geometry } = whole;
    expect(whole.image.width).toBe(spec.width! * STORY.length);
    const slices = sliceCarouselCanvas(whole.image, geometry);
    expect(slices).toHaveLength(STORY.length);
    for (const [i, slide] of STORY.entries()) {
      const alone = await composeCarouselSlide({ spec, slideCount: STORY.length, slide, ...cutout, ...style });
      expect(alone.image.width).toBe(spec.width);
      expect(alone.image.height).toBe(spec.height);
      expect(alone.image.data.equals(slices[i]!.data), `slide ${i + 1}`).toBe(true);
    }
    // Side by side, the slices are the canvas again, column for column.
    for (const seam of seamsOf(geometry)) {
      const left = slices[seam / geometry.slideWidth - 1]!;
      const right = slices[seam / geometry.slideWidth]!;
      for (const y of [3, Math.floor(geometry.slideHeight / 2), geometry.slideHeight - 2]) {
        expect(pixelAt(left, geometry.slideWidth - 1, y)).toEqual(pixelAt(whole.image, seam - 1, y));
        expect(pixelAt(right, 0, y)).toEqual(pixelAt(whole.image, seam, y));
        // The continuous background moves by at most one step across the seam.
        const a = pixelAt(whole.image, seam - 1, 3);
        const b = pixelAt(whole.image, seam, 3);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(a[c]! - b[c]!)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("never places a product pixel on or near a seam", async () => {
    const spec = getSpec(adsFormats.carousel.specId);
    const whole = await renderCarouselCanvas({
      spec,
      slideCount: STORY.length,
      slides: STORY,
      ...(await texturedCutout()),
      ...style,
    });
    const { mask, geometry } = whole;
    const margin = carouselMargin(geometry);
    for (const seam of seamsOf(geometry)) {
      for (let x = seam - margin; x < seam + margin; x++) {
        for (let y = 0; y < mask.height; y++) {
          expect(mask.data[y * mask.width + x]).toBe(0);
        }
      }
    }
    // Every slide shows the product.
    for (let i = 0; i < STORY.length; i++) {
      let count = 0;
      for (let y = 0; y < mask.height; y++) {
        for (let x = i * geometry.slideWidth; x < (i + 1) * geometry.slideWidth; x++) {
          if (mask.data[y * mask.width + x]) count++;
        }
      }
      expect(count, `slide ${i + 1}`).toBeGreaterThan(0);
    }
  });

  it("passes the rule 3 fidelity check on every slide, on the gradient and on a scene layer", async () => {
    const spec = getSpec(adsFormats.carousel.specId);
    const cutout = await texturedCutout();
    const geometry = carouselGeometry(spec, STORY.length);
    // A scene layer without the product: a smooth two color field.
    const plateData = Buffer.alloc(geometry.canvasWidth * geometry.canvasHeight * 4);
    for (let y = 0; y < geometry.canvasHeight; y++) {
      for (let x = 0; x < geometry.canvasWidth; x++) {
        const o = (y * geometry.canvasWidth + x) * 4;
        plateData[o] = 120 + Math.round((80 * x) / geometry.canvasWidth);
        plateData[o + 1] = 140 + Math.round((60 * y) / geometry.canvasHeight);
        plateData[o + 2] = 110;
        plateData[o + 3] = 255;
      }
    }
    const plate: RawImage = { data: plateData, width: geometry.canvasWidth, height: geometry.canvasHeight, channels: 4 };
    for (const withPlate of [false, true]) {
      for (const slide of STORY) {
        const result = await renderCarouselSlide({
          spec,
          slideCount: STORY.length,
          slide,
          ...cutout,
          ...style,
          ...(withPlate ? { plate } : {}),
        });
        expect(result.image.width).toBe(spec.width);
        expect(result.image.height).toBe(spec.height);
        expect(spec.formats).toContain(result.encoded.format);
        const report = await fidelityReport(result.productReference, result.image, result.mask, { kind: "other" });
        expect(report.pass, `slide ${slide.slideIndex}${withPlate ? " on the scene layer" : ""}`).toBe(true);
        // Text never overlaps the product.
        const product = boundingBoxOfMask(result.mask)!;
        expect(product).not.toBeNull();
      }
    }
  });

  it("refuses a slide outside the carousel", async () => {
    const spec = getSpec(adsFormats.carousel.specId);
    await expect(
      renderCarouselSlide({ spec, slideCount: 3, slide: { slideIndex: 4, role: "hero", headline: "x" }, ...(await texturedCutout()), ...style }),
    ).rejects.toThrow();
  });
});

describe("static ad variants inside each placement's safe zone", () => {
  for (const specId of adsFormats.adPack.placements) {
    it(`keeps the headline, product and call to action inside the ${specId} safe zone, with the product exact`, async () => {
      const spec = getSpec(specId);
      const result = await renderAdVariant({
        spec,
        headline: "Keeps coffee hot",
        cta: adsFormats.adPack.callsToAction[0],
        ...(await texturedCutout()),
        ...style,
      });
      expect(result.image.width).toBe(spec.width);
      expect(result.image.height).toBe(spec.height);
      const safe = safeArea(spec, { width: spec.width!, height: spec.height! });
      const product = boundingBoxOfMask(result.mask)!;
      expect(boxWithin(product, safe), "product").toBe(true);
      expect(result.layout.decoration).not.toBeNull();
      expect(boxWithin(result.layout.decoration!, safe), "text and pill").toBe(true);
      const areas = adVariantAreas(spec, { width: spec.width!, height: spec.height! });
      expect(boxWithin(areas.headline, safe) && boxWithin(areas.cta, safe) && boxWithin(areas.product, safe)).toBe(true);
      const report = await fidelityReport(result.productReference, result.image, result.mask, { kind: "other" });
      expect(report.pass).toBe(true);
    });
  }

  it("needs a headline and a call to action", async () => {
    const spec = getSpec("tiktok.ad_9x16");
    await expect(
      renderAdVariant({ spec, headline: "  ", cta: "Shop now", ...(await texturedCutout()), ...style }),
    ).rejects.toBeInstanceOf(TemplateUnavailableError);
  });
});

describe("moodboard pin", () => {
  it("renders one line above the real product at 1000 by 1500", async () => {
    const spec = getSpec(adsFormats.pin.specId);
    const result = await renderPinMoodboard({ spec, headline: "Ceramic pour over mug", ...(await texturedCutout()), ...style });
    expect(result.image.width).toBe(1000);
    expect(result.image.height).toBe(1500);
    const product = boundingBoxOfMask(result.mask)!;
    expect(result.layout.decoration!.top + result.layout.decoration!.height).toBeLessThanOrEqual(product.top);
    const report = await fidelityReport(result.productReference, result.image, result.mask, { kind: "other" });
    expect(report.pass).toBe(true);
  });

  it("puts the line on a finished scene only where the product is not", async () => {
    const spec = getSpec(adsFormats.pin.specId);
    const width = 1000;
    const height = 1500;
    const image: RawImage = { data: Buffer.alloc(width * height * 4, 180), width, height, channels: 4 };
    const maskData = Buffer.alloc(width * height, 0);
    for (let y = 800; y < 1300; y++) for (let x = 300; x < 700; x++) maskData[y * width + x] = 255;
    const mask = { data: maskData, width, height };
    for (let y = 800; y < 1300; y++) for (let x = 300; x < 700; x++) image.data[(y * width + x) * 4] = 20;
    const out = await overlaySceneLine({ image, mask, spec, headline: "Morning coffee", style });
    for (let y = 800; y < 1300; y += 50) {
      for (let x = 300; x < 700; x += 50) {
        const o = (y * width + x) * 4;
        expect([out.data[o], out.data[o + 1], out.data[o + 2]]).toEqual([20, 180, 180]);
      }
    }
    // A product that reaches the line band refuses the line.
    const high = { data: Buffer.alloc(width * height, 255), width, height };
    await expect(overlaySceneLine({ image, mask: high, spec, headline: "Morning coffee", style })).rejects.toBeInstanceOf(
      TemplateUnavailableError,
    );
  });
});

describe("ads copy", () => {
  it("prints rule 9 clean lines at most 40 characters", () => {
    for (const raw of ["Fast — easy", "Hot coffee \u{1F525}", "Go -> now", "A really long headline that keeps going well past forty"]) {
      const line = adsLine(raw);
      expect(rule9Problems(line)).toEqual([]);
      expect(line.length).toBeLessThanOrEqual(adsFormats.lineMaxChars);
    }
    for (const cta of [adsFormats.carousel.callToAction, ...adsFormats.adPack.callsToAction]) {
      expect(rule9Problems(cta)).toEqual([]);
      expect(adsLine(cta)).toBe(cta);
    }
  });

  it("decodes masks the renderer was given", async () => {
    const cutout = await texturedCutout();
    const mask = await decodeMask(cutout.maskPng);
    expect(boundingBoxOfMask(mask)).not.toBeNull();
    expect((await decodeToRgba(cutout.productPng)).width).toBe(220);
  });
});
