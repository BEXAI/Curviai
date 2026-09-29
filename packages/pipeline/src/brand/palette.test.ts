import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ciede2000, hexToRgb, rgbToLab } from "../color";
import { brandPalette } from "../seed/brand";
import { stillStyle } from "../seed/templates";
import {
  applyPaletteNaming,
  contrastRatio,
  labToRgb,
  logoVisionJpeg,
  paletteNeedsVision,
  paletteNamingPayload,
  plainColorName,
  readLogoPalette,
  readPaletteFromRgba,
  suggestionFromReading,
  textColorFor,
} from "./palette";

// docs/phases/PHASE_16.md workstream 7: known logo fixtures return their
// palette within a delta E of 2; transparent logos work.

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

async function png(svg: Buffer): Promise<Buffer> {
  return sharp(svg).png().toBuffer();
}

function labOf(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

function expectPalette(actual: readonly string[], expected: readonly string[]) {
  expect(actual).toHaveLength(expected.length);
  for (const want of expected) {
    const best = Math.min(...actual.map((got) => ciede2000(labOf(got), labOf(want))));
    expect(best, `${want} in ${actual.join(", ")}`).toBeLessThan(2);
  }
}

/** Vertical stripes of flat colors, fully opaque. */
function stripes(hexes: readonly string[], stripeWidth = 20, height = 40): Buffer {
  const width = stripeWidth * hexes.length;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = hexToRgb(hexes[Math.floor(x / stripeWidth)]);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return data;
}

describe("readLogoPalette on fixtures", () => {
  it("reads a transparent three color logo within delta E 2, the largest color first", async () => {
    const reading = await readLogoPalette(await png(fixture("three-color-transparent.svg")));
    expectPalette(
      reading.colors.map((c) => c.hex),
      ["#D7263D", "#1B2A4A", "#F4B400"],
    );
    expect(reading.ambiguity).toEqual([]);
    expect(paletteNeedsVision(reading)).toBe(false);
    // The navy bars cover more area than the red disc, and the gold dot least.
    expect(ciede2000(reading.colors[0].lab, labOf("#1B2A4A"))).toBeLessThan(2);
    expect(ciede2000(reading.colors[2].lab, labOf("#F4B400"))).toBeLessThan(2);
    // Transparent pixels are never counted.
    expect(reading.keptPixels).toBeLessThan(reading.sampledPixels);
  });

  it("ignores the white box of a JPEG logo and survives compression noise", async () => {
    const jpeg = await sharp(fixture("two-color-on-white.svg")).jpeg({ quality: 82 }).toBuffer();
    const reading = await readLogoPalette(jpeg);
    expectPalette(
      reading.colors.map((c) => c.hex),
      ["#0B6E4F", "#2B2D31"],
    );
    expect(reading.ambiguity).toEqual([]);
  });

  it("returns no colors for an all white logo instead of guessing", async () => {
    const reading = await readLogoPalette(await png(fixture("white-on-transparent.svg")));
    expect(reading.colors).toEqual([]);
    expect(reading.keptPixels).toBe(0);
    expect(paletteNeedsVision(reading)).toBe(false);
    const suggestion = suggestionFromReading(reading);
    expect(suggestion.colors).toEqual([]);
    expect(suggestion.background.hex).toBe(stillStyle.whiteHex);
  });

  it("flags a gradient logo as ambiguous so the vision namer may be asked", async () => {
    const reading = await readLogoPalette(await png(fixture("gradient.svg")));
    // A smooth ramp splits into more steps than the kit takes.
    expect(reading.ambiguity.length).toBeGreaterThan(0);
    expect(paletteNeedsVision(reading)).toBe(true);
    expect(reading.colors.length).toBeGreaterThan(0);
    expect(reading.colors.length).toBeLessThanOrEqual(brandPalette.maxColors);
  });

  it("flags more colors than the kit takes and keeps the first maxColors", () => {
    const hexes = ["#E63946", "#1D3557", "#2A9D8F", "#F4A261", "#6A4C93", "#8AC926", "#111111"];
    const reading = readPaletteFromRgba(stripes(hexes));
    expect(reading.candidates).toHaveLength(7);
    expect(reading.colors).toHaveLength(brandPalette.maxColors);
    expect(reading.ambiguity).toContain("too_many_colors");
    expectPalette(
      reading.candidates.map((c) => c.hex),
      hexes,
    );
  });

  it("flags low coverage when the kit colors cover too little of the logo", () => {
    const reading = readPaletteFromRgba(stripes(["#1D3557", "#E63946"]), {
      ...brandPalette,
      ambiguity: { ...brandPalette.ambiguity, minCoverage: 1.01 },
    });
    expect(reading.ambiguity).toEqual(["low_coverage"]);
    const clean = readPaletteFromRgba(stripes(["#1D3557", "#E63946"]));
    expect(clean.ambiguity).toEqual([]);
    expect(clean.coverage).toBe(1);
  });

  it("is deterministic", async () => {
    const bytes = await png(fixture("three-color-transparent.svg"));
    const [a, b] = await Promise.all([readLogoPalette(bytes), readLogoPalette(bytes)]);
    expect(a).toEqual(b);
  });

  it("draws the vision image on the seeded gray so white parts stay visible", async () => {
    const jpeg = await logoVisionJpeg(await png(fixture("white-on-transparent.svg")));
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(brandPalette.visionLongSide);
    const corner = [data[0], data[1], data[2]];
    const gray = hexToRgb(stillStyle.sweepGrayHex);
    expect(Math.abs(corner[0] - gray.r)).toBeLessThanOrEqual(3);
  });
});

describe("contrast pairs", () => {
  it("uses the WCAG ratio from the relative luminance helper", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#123456", "#123456")).toBe(1);
  });

  it("picks the seeded text color that reads best and says whether it passes", () => {
    const onNavy = textColorFor("#1B2A4A");
    expect(onNavy.textHex).toBe(stillStyle.textOnDarkHex);
    expect(onNavy.passes).toBe(true);
    const onGold = textColorFor("#F4B400");
    expect(onGold.textHex).toBe(stillStyle.textHex);
    expect(onGold.ratio).toBeGreaterThanOrEqual(brandPalette.minContrastRatio);
    // A mid tone neither seeded text color reads on is reported, not hidden.
    const onMid = textColorFor("#7A7A7A");
    expect(onMid.passes).toBe(false);
  });

  it("suggests a pale background of the leading hue that passes with its text", async () => {
    const reading = await readLogoPalette(await png(fixture("three-color-transparent.svg")));
    const suggestion = suggestionFromReading(reading);
    const bg = labOf(suggestion.background.hex);
    expect(bg.L).toBeGreaterThanOrEqual(stillStyle.lightEdgeBelowLightness);
    expect(suggestion.background.text.passes).toBe(true);
    for (const color of suggestion.colors) {
      expect(color.text.backgroundHex).toBe(color.hex);
      expect(color.name.length).toBeGreaterThan(0);
    }
    expect(suggestion.source).toBe("pixels");
  });

  it("round trips Lab to sRGB", () => {
    for (const hex of ["#D7263D", "#1B2A4A", "#F4B400", "#FFFFFF", "#000000"]) {
      const [r, g, b] = labToRgb(labOf(hex));
      const { r: r0, g: g0, b: b0 } = hexToRgb(hex);
      expect(Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)).toBeLessThanOrEqual(3);
    }
  });
});

describe("applyPaletteNaming", () => {
  const hexes = ["#E63946", "#1D3557", "#2A9D8F", "#F4A261", "#6A4C93", "#8AC926", "#111111"];
  const reading = readPaletteFromRgba(stripes(hexes));

  it("sends the candidates and the color limit, nothing else", () => {
    const payload = paletteNamingPayload(reading);
    expect(payload.maxColors).toBe(brandPalette.maxColors);
    expect(payload.candidates.map((c) => c.hex)).toEqual(reading.candidates.map((c) => c.hex));
  });

  it("keeps only measured candidates, once each, in the answer's order, with plain names", () => {
    const [first, second] = [reading.candidates[3], reading.candidates[0]];
    const suggestion = applyPaletteNaming(reading, {
      colors: [
        { hex: first.hex.toLowerCase(), name: "Sunset - orange!" },
        { hex: "#ABCDEF", name: "invented" },
        { hex: second.hex, name: "brick red" },
        { hex: first.hex, name: "again" },
      ],
    });
    expect(suggestion.source).toBe("vision");
    expect(suggestion.colors.map((c) => c.hex)).toEqual([first.hex, second.hex]);
    expect(suggestion.colors[0].name).toBe("sunset orange");
    expect(suggestion.colors[1].name).toBe("brick red");
  });

  it("caps the answer at maxColors", () => {
    const suggestion = applyPaletteNaming(reading, {
      colors: reading.candidates.map((c) => ({ hex: c.hex, name: "color" })),
    });
    expect(suggestion.colors).toHaveLength(brandPalette.maxColors);
  });

  it("falls back to the pixel suggestion on an unusable answer", () => {
    for (const answer of [null, { colors: [] }, { colors: [{ hex: "#000001", name: "x" }] }, "text"]) {
      const suggestion = applyPaletteNaming(reading, answer);
      expect(suggestion.source).toBe("pixels");
      expect(suggestion.colors.map((c) => c.hex)).toEqual(reading.colors.map((c) => c.hex));
    }
  });

  it("strips anything but letters and spaces from names", () => {
    expect(plainColorName("  Deep—navy 😀 -> blue  ")).toBe("deep navy blue");
    expect(plainColorName("x".repeat(80))).toHaveLength(brandPalette.nameMaxLength);
  });
});
