import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { erode } from "../mask";
import { fidelityReport } from "../qc/fidelity";
import { decodeToRgba, encodeJpeg, solidCanvas } from "../raw";
import { stillStyle } from "../seed/templates";
import { productFromSvg, rectProduct } from "../testutil";
import { buildProductReferenceFromEncoded, encodeUnderLimit, makeAmazonMain, makeOnBackground } from "./whiten";

const NAVY: readonly [number, number, number] = [31, 42, 68];
/** A spec at a small square size, so the pixel loops stay quick. */
const small = (id: string): ChannelSpec => ({ ...getSpec(id), width: 400, height: 400, maxBytes: undefined });

describe("makeOnBackground", () => {
  it("keeps product pixels identical to the white render inside the eroded mask", async () => {
    const product = await productFromSvg(
      `<ellipse cx="128" cy="128" rx="80" ry="100" fill="rgb(180,40,40)"/><rect x="100" y="90" width="56" height="20" fill="rgb(250,250,250)"/>`,
      `<ellipse cx="128" cy="128" rx="80" ry="100" fill="white"/>`,
    );
    const spec = small("etsy.listing");
    const white = await makeOnBackground(product.source, product.mask, spec, { rgb: [255, 255, 255] });
    const navy = await makeOnBackground(product.source, product.mask, spec, { rgb: NAVY });
    expect(navy.placement).toEqual(white.placement);
    // The still QC erosion: lanczos reach times the scale, plus one.
    const inner = await erode(navy.mask, Math.ceil(3 * (navy.placement.width / navy.placement.crop.width)) + 1);
    let differ = 0;
    for (let i = 0; i < inner.data.length; i++) {
      if (inner.data[i] === 0) continue;
      const o = i * 4;
      if (navy.raw.data[o] !== white.raw.data[o] || navy.raw.data[o + 1] !== white.raw.data[o + 1] || navy.raw.data[o + 2] !== white.raw.data[o + 2]) {
        differ++;
      }
    }
    expect(differ).toBe(0);
    // Outside the mask every pixel is exactly the color, and edges blend toward it.
    let outside = 0;
    let exact = 0;
    for (let i = 0; i < navy.mask.data.length; i++) {
      if (navy.mask.data[i] !== 0) continue;
      outside++;
      const o = i * 4;
      if (navy.raw.data[o] === NAVY[0] && navy.raw.data[o + 1] === NAVY[1] && navy.raw.data[o + 2] === NAVY[2]) exact++;
    }
    expect(exact).toBe(outside);
  });

  it("keeps amazon.main exactly 255 white through makeAmazonMain", async () => {
    const product = await rectProduct(256);
    const main = await makeAmazonMain(product.source, product.mask, getSpec("amazon.main"));
    for (let i = 0; i < main.mask.data.length; i++) {
      if (main.mask.data[i] !== 0) continue;
      const o = i * 4;
      if (main.raw.data[o] !== 255 || main.raw.data[o + 1] !== 255 || main.raw.data[o + 2] !== 255) {
        throw new Error(`pixel ${i} is not white`);
      }
    }
  });

  it("keeps the product inside the safe zone on meta.story_9x16", async () => {
    const product = await rectProduct(256);
    const spec = getSpec("meta.story_9x16");
    const zone = spec.safeZone ?? { top: 0, bottom: 0 };
    const result = await makeOnBackground(product.source, product.mask, spec, { rgb: NAVY });
    expect(result.placement.top).toBeGreaterThanOrEqual(zone.top);
    expect(result.placement.top + result.placement.height).toBeLessThanOrEqual(result.height - zone.bottom);
  });
});

describe("encoders take the flatten color", () => {
  it("encodeUnderLimit and encodeJpeg flatten transparency onto the color given", async () => {
    const clear = solidCanvas(32, 32, 0, 0, 0, 0);
    const viaLimit = await decodeToRgba((await encodeUnderLimit(clear, undefined, "#1F2A44")).jpeg);
    const viaJpeg = await decodeToRgba(await encodeJpeg(clear, 95, "#1F2A44"));
    for (const image of [viaLimit, viaJpeg]) {
      expect(Math.abs(image.data[0] - NAVY[0])).toBeLessThanOrEqual(2);
      expect(Math.abs(image.data[2] - NAVY[2])).toBeLessThanOrEqual(2);
    }
    const white = await decodeToRgba(await encodeJpeg(clear));
    expect([white.data[0], white.data[1], white.data[2]]).toEqual([255, 255, 255]);
  });
});

describe("buildProductReferenceFromEncoded", () => {
  it("places the resized photo and leaves the rest clear", async () => {
    const photo = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 200, b: 30 } } })
      .png()
      .toBuffer();
    const ref = await buildProductReferenceFromEncoded(
      photo,
      { crop: { left: 0, top: 0, width: 300, height: 200 }, left: 20, top: 50, width: 150, height: 100, kernel: "lanczos3" },
      { width: 200, height: 200 },
    );
    expect([ref.width, ref.height]).toEqual([200, 200]);
    const at = (x: number, y: number) => [...ref.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(60, 100)).toEqual([10, 200, 30, 255]);
  });

  it("matches the pixels fidelity compares for a cropped window", async () => {
    const photo = await rectProduct(512);
    const placement = { crop: { left: 100, top: 80, width: 300, height: 300 }, left: 0, top: 0, width: 200, height: 200, kernel: "lanczos3" as const };
    const ref = await buildProductReferenceFromEncoded(photo.source, placement, { width: 200, height: 200 });
    const independent = await sharp(photo.source)
      .extract(placement.crop)
      .resize(200, 200, { fit: "fill", kernel: "lanczos3", fastShrinkOnLoad: false })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const full = { data: Buffer.alloc(200 * 200, 255), width: 200, height: 200 };
    const report = await fidelityReport({ data: independent, width: 200, height: 200, channels: 4 }, ref, full, { erodePx: 0, exact: true });
    expect(report.pass).toBe(true);
  });
});

describe("renderer code carries no color literals (rule 2)", () => {
  it("finds no hex color literal in the deterministic renderers, raw.ts, qc or the packager", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.join(here, "..");
    const files: string[] = [path.join(src, "raw.ts")];
    for (const dir of ["deterministic", "qc", "packager"]) {
      for (const name of await readdir(path.join(src, dir))) {
        if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "testing.ts") {
          files.push(path.join(src, dir, name));
        }
      }
    }
    const literal = /["'`]#[0-9A-Fa-f]{3,8}["'`]/;
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (literal.test(line)) offenders.push(`${path.relative(src, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
    expect(stillStyle.whiteHex).toBe("#FFFFFF");
  });
});
