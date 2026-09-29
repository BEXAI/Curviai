/**
 * The dark swatch gate (PHASE_15 control 3): a synthetic anti aliased
 * product, photographed on a light studio background like every real
 * cutout, placed on every seeded swatch and one dark custom color. A light
 * fringe is an edge pixel clearly lighter than both the product and the
 * background. Swatches that show one do not ship in the P0 list.
 */
import { describe, expect, it } from "vitest";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { hexToRgb, rgbToLab } from "../color";
import { dilate, erode } from "../mask";
import type { RawImage, RawMask } from "../raw";
import { backgroundSwatches } from "../seed/templates";
import { productFromSvg } from "../testutil";
import { showsLightEdge } from "./edge";
import { makeOnBackground } from "./whiten";

/** An edge pixel this many L* units lighter than both sides reads as a fringe. */
const FRINGE_L = 3;
/** Share of edge pixels allowed to be a fringe. */
const FRINGE_SHARE = 0.01;
/** One dark custom color, darker than every seeded swatch. */
const DARK_CUSTOM_HEX = "#101418";

const PRODUCTS = [
  { name: "navy", fill: "rgb(30,40,90)" },
  { name: "red", fill: "rgb(180,40,40)" },
];

const spec: ChannelSpec = { ...getSpec("etsy.listing"), id: "test.fringe", width: 480, height: 480, maxBytes: undefined };

async function fringeShare(fill: string, hex: string): Promise<number> {
  const product = await productFromSvg(
    `<circle cx="128" cy="128" r="90" fill="${fill}"/>`,
    `<circle cx="128" cy="128" r="90" fill="white"/>`,
    { size: 256, background: 240 },
  );
  const { r, g, b } = hexToRgb(hex);
  const result = await makeOnBackground(product.source, product.mask, spec, { rgb: [r, g, b] });
  return measureFringe(result.raw, result.mask, [r, g, b]);
}

async function measureFringe(image: RawImage, mask: RawMask, bg: readonly [number, number, number]): Promise<number> {
  const inner = await erode(mask, 6);
  const outer = await dilate(mask, 3);
  const core = await erode(mask, 3);
  let productL = 0;
  let count = 0;
  for (let i = 0; i < inner.data.length; i++) {
    if (inner.data[i] === 0) continue;
    productL += rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]).L;
    count++;
  }
  productL /= Math.max(1, count);
  const ceiling = Math.max(productL, rgbToLab(bg[0], bg[1], bg[2]).L) + FRINGE_L;
  let band = 0;
  let fringe = 0;
  for (let i = 0; i < outer.data.length; i++) {
    if (outer.data[i] === 0 || core.data[i] !== 0) continue;
    band++;
    if (rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]).L > ceiling) fringe++;
  }
  return band === 0 ? 0 : fringe / band;
}

/** The two dark swatches the plan proposed for P0, and one dark custom color. */
const DARK_CANDIDATES = [
  ["slate", "#3A4556"],
  ["charcoal", "#1B1F24"],
  ["dark custom", DARK_CUSTOM_HEX],
] as const;

async function worstFringe(hex: string): Promise<number> {
  let worst = 0;
  for (const product of PRODUCTS) {
    worst = Math.max(worst, await fringeShare(product.fill, hex));
  }
  return worst;
}

describe("dark swatch gate", () => {
  it.each(Object.entries(backgroundSwatches))("seeded swatch %s shows no light fringe around the product", async (_key, swatch) => {
    expect(await worstFringe(swatch.hex)).toBeLessThanOrEqual(FRINGE_SHARE);
    expect(showsLightEdge(swatch.hex)).toBe(false);
  });

  it.each(DARK_CANDIDATES)("%s shows a light fringe, so it is not a P0 swatch and gets the dark color line", async (_name, hex) => {
    expect(await worstFringe(hex)).toBeGreaterThan(FRINGE_SHARE);
    expect(showsLightEdge(hex)).toBe(true);
    expect(Object.values(backgroundSwatches).map((s) => s.hex)).not.toContain(hex);
  });

  it("puts the seeded lightness threshold where the fringe starts", async () => {
    // Grays at or above the threshold never fringe; the gray just below does.
    for (let level = 0x40; level <= 0xf0; level += 0x10) {
      const hex = `#${level.toString(16).padStart(2, "0").repeat(3)}`.toUpperCase();
      const fringe = (await worstFringe(hex)) > FRINGE_SHARE;
      expect(fringe, hex).toBe(showsLightEdge(hex));
    }
  });
});
