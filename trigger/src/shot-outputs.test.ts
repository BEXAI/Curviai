import { describe, expect, it } from "vitest";
import {
  decodeToRgba,
  deriveQcErodePx,
  encodeJpeg,
  erode,
  fidelityReport,
  solidCanvas,
  type RawImage,
  type RawMask,
} from "@curvi/pipeline";
import { canvasDefaults } from "@curvi/pipeline/seed";
import { getSpec, listSpecs, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import { ShotUnavailableError } from "./errors";
import {
  canvasSizeFor,
  compositeQcErosion,
  encodeForSpec,
  fitsSpecSize,
  maskArea,
  measureBackgroundRgb,
  MIN_QC_AREA_SHARE,
  qcErodeWithFloor,
  resizeCanvasTo,
  stillQcErosion,
  exactBackgroundRgb,
} from "./shot-outputs";

function rectMask(width: number, height: number, box: { left: number; top: number; width: number; height: number }): RawMask {
  const data = Buffer.alloc(width * height, 0);
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      data[y * width + x] = 255;
    }
  }
  return { data, width, height };
}

/** Seeded full range noise inside the mask, a flat background outside. */
function noisyImage(mask: RawMask, amplitude: number, background = 255): RawImage {
  const image = solidCanvas(mask.width, mask.height, background, background, background);
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) continue;
    for (let c = 0; c < 3; c++) {
      image.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(128 + (rand() - 0.5) * 2 * amplitude)));
    }
  }
  return image;
}

describe("qcErodeWithFloor (2.2)", () => {
  it("keeps the desired erosion for a chunky product", async () => {
    const mask = rectMask(200, 200, { left: 40, top: 40, width: 120, height: 120 });
    expect(await qcErodeWithFloor(mask, 7, 3)).toBe(7);
  });

  it("lowers the erosion for a thin product until enough of the mask remains, never below the floor", async () => {
    const mask = rectMask(200, 200, { left: 20, top: 97, width: 160, height: 6 });
    // Eroding 5 would leave nothing to compare.
    expect(maskArea(await erode(mask, 5))).toBe(0);
    const px = await qcErodeWithFloor(mask, 5, 1);
    expect(px).toBeGreaterThanOrEqual(1);
    expect(px).toBeLessThan(5);
    expect(maskArea(await erode(mask, px))).toBeGreaterThanOrEqual(maskArea(mask) * MIN_QC_AREA_SHARE);
    // The largest such erosion: one more pixel would drop under the share.
    expect(maskArea(await erode(mask, px + 1))).toBeLessThan(maskArea(mask) * MIN_QC_AREA_SHARE);
  });

  it("stops at the floor even when the floor keeps less than the share", async () => {
    const mask = rectMask(100, 100, { left: 10, top: 48, width: 80, height: 3 });
    expect(await qcErodeWithFloor(mask, 7, 2)).toBe(2);
  });

  it("derives a composite's check region from the paste erosion it applied", async () => {
    const chunky = rectMask(200, 200, { left: 40, top: 40, width: 120, height: 120 });
    expect(await compositeQcErosion(chunky, 3)).toEqual({ erodePx: deriveQcErodePx(3), floorPx: 3 });
    const thin = rectMask(200, 200, { left: 20, top: 97, width: 160, height: 6 });
    const erosion = await compositeQcErosion(thin, 1);
    expect(erosion.floorPx).toBe(1);
    expect(erosion.erodePx).toBeLessThan(deriveQcErodePx(1));
    expect(maskArea(await erode(thin, erosion.erodePx))).toBeGreaterThan(0);
  });

  it("widens a still's erosion with the upscale and floors it for thin products", async () => {
    const chunky = rectMask(400, 400, { left: 50, top: 50, width: 300, height: 300 });
    expect((await stillQcErosion(chunky, 10)).erodePx).toBe(31);
    expect((await stillQcErosion(chunky, 0.5)).erodePx).toBe(deriveQcErodePx());
    const thinBar = rectMask(400, 400, { left: 20, top: 150, width: 360, height: 60 });
    const erosion = await stillQcErosion(thinBar, 10);
    expect(erosion.floorPx).toBe(11);
    expect(erosion.erodePx).toBeGreaterThanOrEqual(11);
    expect(erosion.erodePx).toBeLessThan(31);
  });
});

describe("encodeForSpec (2.3)", () => {
  const jpgOnly = (overrides: Partial<ChannelSpec> = {}): ChannelSpec => ({
    id: "test.jpg_only",
    verified: false,
    width: 256,
    height: 256,
    formats: ["jpg"],
    ...overrides,
  });
  const mask = rectMask(256, 256, { left: 48, top: 48, width: 160, height: 160 });
  const raw = noisyImage(mask, 90);

  it("returns the pixels decoded from the bytes it ships", async () => {
    const out = await encodeForSpec(raw, mask, raw, jpgOnly(), { erodePx: 0 });
    expect(out.encoded.format).toBe("jpg");
    const decoded = await decodeToRgba(out.encoded.buffer);
    expect(decoded.data.equals(out.image.data)).toBe(true);
  });

  it("moves to a higher quality when codec error shifts product pixels past the limit", async () => {
    const q90 = await decodeToRgba(await encodeJpeg(raw, 90));
    expect((await fidelityReport(raw, q90, mask, { kind: "other", erodePx: 0 })).pass).toBe(false);
    const out = await encodeForSpec(raw, mask, raw, jpgOnly(), { erodePx: 0 });
    expect((await fidelityReport(raw, out.image, mask, { kind: "other", erodePx: 0 })).pass).toBe(true);
    expect(out.encoded.buffer.length).toBeGreaterThan((await encodeJpeg(raw, 90)).length);
  });

  it("sends the output to review when no quality the spec accepts keeps the product", async () => {
    const q90Bytes = (await encodeJpeg(raw, 90)).length;
    await expect(
      encodeForSpec(raw, mask, raw, jpgOnly({ maxBytes: q90Bytes + 1 }), { erodePx: 0 }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("checks the white inside a placed photo rectangle against the background mask", async () => {
    // An already white kept photo: the fidelity mask is the placed photo
    // rectangle, the whole canvas here, and the product sits inside it on
    // white with one off white patch a JPEG must not ship.
    const product = rectMask(256, 256, { left: 80, top: 80, width: 96, height: 96 });
    const photo = noisyImage(product, 10);
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        photo.data.fill(250, (y * 256 + x) * 4, (y * 256 + x) * 4 + 3);
      }
    }
    const rectangle = rectMask(256, 256, { left: 0, top: 0, width: 256, height: 256 });
    const white = jpgOnly({ formats: ["jpg", "png"], background: { type: "white_preferred" } });
    const rectOnly = await encodeForSpec(photo, rectangle, photo, white, { erodePx: 0, fidelityKind: "other" });
    expect(rectOnly.encoded.format).toBe("jpg");
    const checked = await encodeForSpec(photo, rectangle, photo, white, {
      erodePx: 0,
      fidelityKind: "other",
      backgroundMask: product,
    });
    expect(checked.encoded.format).toBe("png");
    await expect(
      encodeForSpec(photo, rectangle, photo, { ...white, formats: ["jpg"] }, {
        erodePx: 0,
        fidelityKind: "other",
        backgroundMask: product,
      }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("prefers lossless PNG when asked and the spec takes it", async () => {
    const out = await encodeForSpec(raw, mask, raw, jpgOnly({ formats: ["jpg", "png"] }), { preferPng: true });
    expect(out.encoded.format).toBe("png");
    expect(out.image.data.equals(raw.data)).toBe(true);
  });
});

describe("measureBackgroundRgb (2.15)", () => {
  it("reports the dominant color outside the product, not a spec constant", async () => {
    const mask = rectMask(64, 64, { left: 16, top: 16, width: 32, height: 32 });
    expect(await measureBackgroundRgb(noisyImage(mask, 40, 254), mask)).toEqual([254, 254, 254]);
    expect(await measureBackgroundRgb(noisyImage(mask, 40, 255), mask)).toEqual([255, 255, 255]);
  });

  it("is null for a fully transparent background", async () => {
    const mask = rectMask(32, 32, { left: 8, top: 8, width: 16, height: 16 });
    const image = solidCanvas(32, 32, 0, 0, 0, 0);
    expect(await measureBackgroundRgb(image, mask)).toBeNull();
  });
});

describe("canvas sizes and re-framing (2.11)", () => {
  it("takes fixed spec sizes and the seeded default for open ones", () => {
    expect(canvasSizeFor(getSpec("amazon.secondary"))).toEqual({ width: 2000, height: 2000 });
    expect(canvasSizeFor(getSpec("google.merchant.lifestyle"))).toEqual({
      width: canvasDefaults.width,
      height: canvasDefaults.width,
    });
    expect(fitsSpecSize(getSpec("google.merchant.lifestyle"), 2048, 2048)).toBe(true);
    expect(fitsSpecSize(getSpec("amazon.secondary"), 2048, 2048)).toBe(false);
  });

  it("re-frames around the product and keeps rule 3 provable at the new size", async () => {
    const mask = rectMask(400, 400, { left: 150, top: 120, width: 100, height: 160 });
    const raw = noisyImage(mask, 30, 240);
    const erosion = { erodePx: 3, floorPx: 1 };
    const resized = await resizeCanvasTo(raw, mask, raw, erosion, { width: 216, height: 270 });
    expect(resized.image.width).toBe(216);
    expect(resized.image.height).toBe(270);
    expect(resized.erosion.erodePx).toBeGreaterThan(erosion.erodePx);
    const report = await fidelityReport(resized.productReference, resized.image, resized.mask, {
      kind: "other",
      erodePx: resized.erosion.erodePx,
    });
    expect(report.maskArea).toBeGreaterThan(0);
    expect(report.pass).toBe(true);
  });

  it("refuses a shape that would cut the product off", async () => {
    const mask = rectMask(400, 400, { left: 20, top: 180, width: 360, height: 40 });
    const raw = noisyImage(mask, 30);
    await expect(
      resizeCanvasTo(raw, mask, raw, { erodePx: 3, floorPx: 1 }, { width: 100, height: 400 }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });
});

describe("exactBackgroundRgb (PHASE_15 item 19)", () => {
  it("holds every white required spec to exact white and leaves open backgrounds alone", () => {
    for (const spec of listSpecs()) {
      const rgb = exactBackgroundRgb(spec);
      if (requiresWhiteBackground(spec)) {
        expect(rgb, spec.id).toEqual([255, 255, 255]);
      } else if (spec.background?.type !== "solid") {
        expect(rgb, spec.id).toBeNull();
      }
    }
    expect(exactBackgroundRgb(getSpec("google.merchant.main"))).toEqual([255, 255, 255]);
    expect(exactBackgroundRgb(getSpec("amazon.secondary"))).toBeNull();
  });
});
