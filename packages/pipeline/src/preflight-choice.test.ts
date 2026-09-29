import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderCutoutPreview, renderPieceThumbnails } from "./contact-sheet";
import { analyzeInventory, chooseInventoryTarget, noteSignals, piecesInBox } from "./inventory";
import { uprightSize, type RawImage } from "./raw";
import type { IntakeProduct } from "./schemas";
import { MAX_SOURCE_UPSCALE, sizeRequirementFor, sizeVerdicts } from "./size-gate";

// docs/phases/PHASE_14.md workstream 4 and item 3.2: the product the seller
// taps in the chooser at upload, the chooser's thumbnails, and the size gate.

const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 40, 200];

function cutout(width: number, height: number, rects: Array<{ left: number; top: number; width: number; height: number; rgb: [number, number, number] }>): RawImage {
  const data = Buffer.alloc(width * height * 4, 0);
  for (const r of rects) {
    for (let y = r.top; y < r.top + r.height; y++) {
      for (let x = r.left; x < r.left + r.width; x++) {
        const o = (y * width + x) * 4;
        data[o] = r.rgb[0];
        data[o + 1] = r.rgb[1];
        data[o + 2] = r.rgb[2];
        data[o + 3] = 255;
      }
    }
  }
  return { data, width, height, channels: 4 };
}

/** Red bottle on the left, blue on the right, on a 400 x 300 cutout. */
const twoBottles = () =>
  cutout(400, 300, [
    { left: 40, top: 50, width: 150, height: 200, rgb: RED },
    { left: 200, top: 50, width: 150, height: 200, rgb: BLUE },
  ]);
const redBox = { x: 0.1, y: 50 / 300, width: 0.375, height: 200 / 300 };
const blueBox = { x: 0.5, y: 50 / 300, width: 0.375, height: 200 / 300 };
const product = (label: string, box: IntakeProduct["box"], matchesIntent: IntakeProduct["matchesIntent"]) => ({
  label,
  box,
  matchesIntent,
});

describe("the seller's chosen box", () => {
  const objects = analyzeInventory(twoBottles()).objects;

  it("finds the pieces inside a chosen box, loose or tight", () => {
    expect(piecesInBox(objects, blueBox)).toEqual([1]);
    expect(piecesInBox(objects, { x: 0.45, y: 0.1, width: 0.5, height: 0.8 })).toEqual([1]);
    expect(piecesInBox(objects, { x: 0, y: 0, width: 0.05, height: 0.05 })).toEqual([]);
  });

  it("wins over the model and the note", () => {
    const products = [product("red bottle", redBox, "no"), product("blue bottle", blueBox, "yes")];
    const signals = noteSignals("the blue one only, not the red");
    expect(chooseInventoryTarget({ objects, products, signals })).toMatchObject({ rule: "model", featured: [1] });
    expect(chooseInventoryTarget({ objects, products, signals: noteSignals(""), chosenBox: redBox })).toEqual({
      rule: "seller",
      featured: [0],
      removed: [1],
      touching: false,
    });
    // The note excludes red, so the red piece the seller chose is refused as
    // touching, never swapped for another product.
    expect(chooseInventoryTarget({ objects, products, signals, chosenBox: redBox })).toMatchObject({
      rule: "seller",
      featured: [0],
      touching: true,
    });
  });

  it("wins over the in the box role too", () => {
    const decision = chooseInventoryTarget({ objects, products: [], signals: noteSignals(""), multiItem: true, chosenBox: blueBox });
    expect(decision).toMatchObject({ rule: "seller", featured: [1], removed: [0] });
  });

  it("falls back to the other rules when the box holds no piece", () => {
    const decision = chooseInventoryTarget({
      objects,
      products: [],
      signals: noteSignals("blue only"),
      chosenBox: { x: 0, y: 0, width: 0.05, height: 0.05 },
    });
    expect(decision.rule).toBe("note");
    expect(chooseInventoryTarget({ objects, products: [], signals: noteSignals("") , chosenBox: null }).rule).toBe("ambiguous");
  });
});

describe("renderPieceThumbnails", () => {
  it("draws one square JPEG per piece, only that piece's pixels", async () => {
    const img = twoBottles();
    const inv = analyzeInventory(img);
    const thumbs = await renderPieceThumbnails(img, inv.objects.map((o) => o.pixelBox), { size: 64 });
    expect(thumbs).toHaveLength(2);
    for (const [i, thumb] of thumbs.entries()) {
      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(64);
      expect(meta.height).toBe(64);
      const { data } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
      // The center pixel is the piece's own color.
      const o = (32 * 64 + 32) * 3;
      const want = i === 0 ? RED : BLUE;
      expect(Math.abs(data[o] - want[0])).toBeLessThan(40);
      expect(Math.abs(data[o + 2] - want[2])).toBeLessThan(40);
    }
    expect(await renderPieceThumbnails(img, [])).toEqual([]);
  });
});

describe("renderCutoutPreview (PHASE_15 P1)", () => {
  it("draws one piece as an alpha PNG, never enlarged", async () => {
    const img = twoBottles();
    const inv = analyzeInventory(img);
    const blue = inv.objects.find((o) => o.color.name !== "red") ?? inv.objects[1];
    const png = await renderCutoutPreview(img, blue.pixelBox, { longSide: 640 });
    expect(png).not.toBeNull();
    const meta = await sharp(png!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    // Smaller than 640 already, so drawn at its own size.
    expect(Math.max(meta.width!, meta.height!)).toBeLessThan(640);
    const small = await renderCutoutPreview(img, blue.pixelBox, { longSide: 64 });
    const smallMeta = await sharp(small!).metadata();
    expect(Math.max(smallMeta.width!, smallMeta.height!)).toBe(64);
  });

  it("draws every opaque pixel without a piece, and nothing for an empty cutout", async () => {
    const whole = await renderCutoutPreview(twoBottles(), null, { longSide: 640 });
    expect(whole).not.toBeNull();
    expect(await renderCutoutPreview(cutout(20, 20, []), null, { longSide: 640 })).toBeNull();
  });
});

describe("uprightSize", () => {
  it("swaps width and height for rotated EXIF orientations", async () => {
    const plain = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    expect(await uprightSize(plain)).toEqual({ width: 30, height: 20 });
    const rotated = await sharp(plain).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await uprightSize(rotated)).toEqual({ width: 20, height: 30 });
    expect(await uprightSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("size gate", () => {
  it("derives the product size Amazon main needs from the spec, within the upscale limit", () => {
    const main = sizeRequirementFor("amazon.main");
    expect(main).toEqual({ specId: "amazon.main", measure: "product", needs: Math.ceil((1600 * 0.85) / MAX_SOURCE_UPSCALE) });
    expect(sizeRequirementFor("video.social_9x16")).toBeNull();
    expect(sizeRequirementFor("no.such.spec")).toBeNull();
  });

  it("flags a 413 by 486 photo for Amazon and passes a camera photo", () => {
    const small = sizeVerdicts(["amazon.main", "amazon.secondary"], 486, 400);
    expect(small.every((v) => !v.ok)).toBe(true);
    expect(small[0]).toMatchObject({ specId: "amazon.main", has: 400 });
    const big = sizeVerdicts(["amazon.main", "amazon.secondary"], 4032, 2500);
    expect(big.every((v) => v.ok)).toBe(true);
  });

  it("measures the whole photo when the product region is unknown", () => {
    const [verdict] = sizeVerdicts(["amazon.main"], 3000, null);
    expect(verdict).toMatchObject({ has: 3000, ok: true });
  });
});
