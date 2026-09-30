/**
 * Brand kit from a logo (docs/phases/PHASE_16.md workstream 7).
 *
 * Deterministic first: sharp decodes the logo, transparent and near white
 * pixels are ignored, and the rest are clustered with a weighted k means in
 * CIELAB. Close clusters merge, tiny ones (soft edges, noise) drop, and each
 * color's swatch is read from its densest pixels so antialiasing does not
 * pull it off the true ink. No model call for a simple logo.
 *
 * When the reading is ambiguous (more colors than the kit takes, or a
 * gradient or photo where the picked colors cover too little of the logo),
 * the caller may ask the seeded brand_palette_namer recipe through
 * @curvi/ai (trigger/src/brand-palette.ts) and merge its answer with
 * applyPaletteNaming, which only ever keeps candidates measured here.
 *
 * Everything returned is a suggestion: the seller confirms it on /app/brand
 * before anything is saved. Contrast pairs use the WCAG relative luminance
 * helper the template cards already use (output-options.ts).
 */

import sharp from "sharp";
import { z } from "zod";
import { ciede2000, linearToSrgb, rgbToLab, type Lab } from "../color";
import { colorNameOf } from "../inventory";
import { relativeLuminance, rgbToHex } from "../output-options";
import { brandPalette } from "../seed/brand";
import { stillStyle } from "../seed/templates";

type Widen<T> = T extends number ? number : T extends object ? { readonly [K in keyof T]: Widen<T[K]> } : T;

/** The seeded brandPalette shape with plain numbers, so tests and tuning
 * can pass other values. */
export type BrandPaletteConfig = Widen<typeof brandPalette>;

/** A text color on a background and whether the pair passes the seeded
 * minimum contrast. */
export interface ContrastPair {
  backgroundHex: string;
  textHex: string;
  /** WCAG contrast ratio, rounded to two decimals. */
  ratio: number;
  passes: boolean;
}

/** One color measured from the logo. */
export interface PaletteColor {
  /** Upper case #RRGGBB. */
  hex: string;
  lab: Lab;
  /** Share of the logo's kept (opaque, not near white) pixels. */
  share: number;
}

export interface PaletteReading {
  /** The kit colors, most prominent first, at most maxColors. */
  colors: PaletteColor[];
  /** Every significant color, most prominent first: what the vision recipe
   * may choose from. */
  candidates: PaletteColor[];
  /** Why the vision recipe should be asked; empty when the reading is clean. */
  ambiguity: Array<"too_many_colors" | "low_coverage">;
  /** Share of kept pixels within coverageDeltaE of a kit color. */
  coverage: number;
  /** Pixels read after downscaling, and how many were kept. */
  sampledPixels: number;
  keptPixels: number;
}

/** One color the seller is offered. */
export interface SuggestedColor {
  hex: string;
  name: string;
  share: number;
  /** The text color that reads best on this color. */
  text: ContrastPair;
}

/** What /app/brand shows for confirmation. Nothing here is saved until the
 * seller confirms it. */
export interface BrandKitSuggestion {
  colors: SuggestedColor[];
  /** A pale tint of the leading color for backgrounds, with its text. */
  background: { hex: string; text: ContrastPair };
  /** pixels: the deterministic reading alone. vision: the recipe picked and
   * named the colors from the measured candidates. */
  source: "pixels" | "vision";
  ambiguous: boolean;
}

interface Bin {
  lab: Lab;
  weight: number;
}

interface Cluster {
  center: Lab;
  weight: number;
  bins: number[];
}

function labDistance2(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dL * dL + da * da + db * db;
}

function chroma(lab: Lab): number {
  return Math.hypot(lab.a, lab.b);
}

const LAB_EPS = 6 / 29;
const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

function labFInverse(t: number): number {
  return t > LAB_EPS ? t * t * t : 3 * LAB_EPS * LAB_EPS * (t - 4 / 29);
}

/** CIELAB (D65) back to 8 bit sRGB, clamped to the gamut. */
export function labToRgb(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const x = D65.x * labFInverse(fy + lab.a / 500);
  const y = D65.y * labFInverse(fy);
  const z = D65.z * labFInverse(fy - lab.b / 200);
  const linear = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  const out = linear.map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, c))))) * 255));
  return [out[0], out[1], out[2]];
}

function labToHex(lab: Lab): string {
  return rgbToHex(labToRgb(lab));
}

/** WCAG contrast ratio of two #RRGGBB colors, 1 to 21. */
export function contrastRatio(aHex: string, bHex: string): number {
  const a = relativeLuminance(aHex);
  const b = relativeLuminance(bHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The seeded template text color (stillStyle.textHex or textOnDarkHex)
 * that reads best on a background, with its contrast. A mid tone where
 * neither reaches minContrastRatio comes back with passes false, so the
 * page can say so instead of promising readable text.
 */
export function textColorFor(backgroundHex: string, config: BrandPaletteConfig = brandPalette): ContrastPair {
  const background = backgroundHex.toUpperCase();
  let best: ContrastPair | null = null;
  for (const textHex of [stillStyle.textHex, stillStyle.textOnDarkHex]) {
    const ratio = Math.round(contrastRatio(background, textHex) * 100) / 100;
    if (!best || ratio > best.ratio) {
      best = { backgroundHex: background, textHex, ratio, passes: ratio >= config.minContrastRatio };
    }
  }
  return best as ContrastPair;
}

/**
 * The pale background suggestion: the leading color's hue at the seeded
 * tint lightness, or seed white when the logo gave no color.
 */
export function suggestBackground(colors: readonly PaletteColor[], config: BrandPaletteConfig = brandPalette): string {
  const lead = colors[0];
  if (!lead) {
    return stillStyle.whiteHex;
  }
  const { lightness, chromaScale } = config.backgroundTint;
  return labToHex({ L: lightness, a: lead.lab.a * chromaScale, b: lead.lab.b * chromaScale });
}

/** The kept pixels as weighted bins: 5 bits per RGB channel, each bin
 * carrying the mean Lab of the pixels in it. */
function binPixels(
  data: Buffer,
  config: BrandPaletteConfig,
): { bins: Bin[]; sampled: number; kept: number } {
  const count = new Map<number, number>();
  const sums = new Map<number, [number, number, number]>();
  let sampled = 0;
  let kept = 0;
  for (let o = 0; o + 3 < data.length; o += 4) {
    sampled += 1;
    if (data[o + 3] < config.opaqueAlphaMin) {
      continue;
    }
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const lab = rgbToLab(r, g, b);
    if (lab.L >= config.nearWhite.minLightness && chroma(lab) <= config.nearWhite.maxChroma) {
      continue;
    }
    kept += 1;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    count.set(key, (count.get(key) ?? 0) + 1);
    const sum = sums.get(key);
    if (sum) {
      sum[0] += lab.L;
      sum[1] += lab.a;
      sum[2] += lab.b;
    } else {
      sums.set(key, [lab.L, lab.a, lab.b]);
    }
  }
  // Sorted by key, so the clustering below never depends on Map order.
  const keys = [...count.keys()].sort((a, b) => a - b);
  const bins = keys.map((key) => {
    const n = count.get(key) ?? 1;
    const [L, a, b] = sums.get(key) ?? [0, 0, 0];
    return { lab: { L: L / n, a: a / n, b: b / n }, weight: n };
  });
  return { bins, sampled, kept };
}

function weightedMean(bins: readonly Bin[], members: readonly number[]): Lab {
  let w = 0;
  let L = 0;
  let a = 0;
  let b = 0;
  for (const i of members) {
    const bin = bins[i];
    w += bin.weight;
    L += bin.lab.L * bin.weight;
    a += bin.lab.a * bin.weight;
    b += bin.lab.b * bin.weight;
  }
  return w > 0 ? { L: L / w, a: a / w, b: b / w } : { L: 0, a: 0, b: 0 };
}

/**
 * Weighted k means over the bins in Lab. Seeding is k means++ made
 * deterministic: the heaviest bin first, then each time the bin with the
 * largest weight times squared distance to its nearest center.
 */
function kMeans(bins: readonly Bin[], k: number, maxIterations: number): Cluster[] {
  if (bins.length === 0) {
    return [];
  }
  const centers: Lab[] = [];
  let heaviest = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].weight > bins[heaviest].weight) heaviest = i;
  }
  centers.push({ ...bins[heaviest].lab });
  const nearest = bins.map((bin) => labDistance2(bin.lab, centers[0]));
  while (centers.length < Math.min(k, bins.length)) {
    let pick = -1;
    let score = 0;
    for (let i = 0; i < bins.length; i++) {
      const s = nearest[i] * bins[i].weight;
      if (s > score) {
        score = s;
        pick = i;
      }
    }
    if (pick < 0) {
      break;
    }
    const center = { ...bins[pick].lab };
    centers.push(center);
    for (let i = 0; i < bins.length; i++) {
      nearest[i] = Math.min(nearest[i], labDistance2(bins[i].lab, center));
    }
  }

  const assignment = new Int32Array(bins.length).fill(-1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    for (let i = 0; i < bins.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = labDistance2(bins[i].lab, centers[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }
    for (let c = 0; c < centers.length; c++) {
      const members: number[] = [];
      for (let i = 0; i < bins.length; i++) if (assignment[i] === c) members.push(i);
      if (members.length > 0) centers[c] = weightedMean(bins, members);
    }
    if (!changed) {
      break;
    }
  }

  const clusters: Cluster[] = centers.map((center) => ({ center, weight: 0, bins: [] }));
  for (let i = 0; i < bins.length; i++) {
    const cluster = clusters[assignment[i]];
    cluster.bins.push(i);
    cluster.weight += bins[i].weight;
  }
  return clusters.filter((c) => c.weight > 0);
}

/** Merges the closest pair of clusters while any pair is closer than
 * mergeDeltaE (CIEDE2000). */
function mergeClose(bins: readonly Bin[], clusters: Cluster[], mergeDeltaE: number): Cluster[] {
  const out = clusters.map((c) => ({ ...c, bins: [...c.bins] }));
  for (;;) {
    let pair: [number, number] | null = null;
    let closest = mergeDeltaE;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = ciede2000(out[i].center, out[j].center);
        if (d < closest) {
          closest = d;
          pair = [i, j];
        }
      }
    }
    if (!pair) {
      return out;
    }
    const [i, j] = pair;
    const members = [...out[i].bins, ...out[j].bins];
    out[i] = { center: weightedMean(bins, members), weight: out[i].weight + out[j].weight, bins: members };
    out.splice(j, 1);
  }
}

/** The swatch of a cluster: the mean of its bins within swatchRadius of
 * its densest bin. */
function swatchOf(bins: readonly Bin[], cluster: Cluster, radius: number): Lab {
  let densest = cluster.bins[0];
  for (const i of cluster.bins) {
    if (bins[i].weight > bins[densest].weight) densest = i;
  }
  const r2 = radius * radius;
  const near = cluster.bins.filter((i) => labDistance2(bins[i].lab, bins[densest].lab) <= r2);
  return weightedMean(bins, near);
}

/** Reads the palette from pixels already decoded to RGBA. */
export function readPaletteFromRgba(data: Buffer, config: BrandPaletteConfig = brandPalette): PaletteReading {
  const { bins, sampled, kept } = binPixels(data, config);
  const empty: PaletteReading = {
    colors: [],
    candidates: [],
    ambiguity: [],
    coverage: 0,
    sampledPixels: sampled,
    keptPixels: kept,
  };
  if (kept === 0) {
    return empty;
  }
  const clusters = mergeClose(bins, kMeans(bins, config.clusters, config.maxIterations), config.mergeDeltaE);
  const significant = clusters
    .filter((c) => c.weight / kept >= config.minShare)
    .sort((a, b) => b.weight - a.weight || a.center.L - b.center.L);
  const candidates = significant.map((cluster) => {
    const lab = swatchOf(bins, cluster, config.swatchRadius);
    const hex = labToHex(lab);
    return { hex, lab: rgbToLab(...labToRgb(lab)), share: Math.round((cluster.weight / kept) * 1000) / 1000 };
  });
  // Two clusters can land on one swatch after rounding; keep the first.
  const unique = candidates.filter((c, i) => candidates.findIndex((o) => o.hex === c.hex) === i);
  const colors = unique.slice(0, config.maxColors);
  const coverage = coverageOf(bins, kept, colors, config.ambiguity.coverageDeltaE);
  const ambiguity: PaletteReading["ambiguity"] = [];
  if (unique.length > config.maxColors) ambiguity.push("too_many_colors");
  if (coverage < config.ambiguity.minCoverage) ambiguity.push("low_coverage");
  return { colors, candidates: unique, ambiguity, coverage, sampledPixels: sampled, keptPixels: kept };
}

function coverageOf(bins: readonly Bin[], kept: number, colors: readonly PaletteColor[], deltaE: number): number {
  if (colors.length === 0 || kept === 0) {
    return 0;
  }
  let covered = 0;
  for (const bin of bins) {
    if (colors.some((c) => ciede2000(bin.lab, c.lab) <= deltaE)) {
      covered += bin.weight;
    }
  }
  return Math.round((covered / kept) * 1000) / 1000;
}

/**
 * Reads a logo's palette: sharp decodes it upright, downscaled to at most
 * sampleLongSide, and the RGBA pixels go to readPaletteFromRgba. Throws
 * when sharp cannot read the file.
 */
export async function readLogoPalette(bytes: Buffer, config: BrandPaletteConfig = brandPalette): Promise<PaletteReading> {
  const { data } = await sharp(bytes)
    .rotate()
    .resize({ width: config.sampleLongSide, height: config.sampleLongSide, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return readPaletteFromRgba(data, config);
}

/** The logo as the vision recipe sees it: at most visionLongSide, on the
 * seeded gray sweep, so white and transparent parts both stay visible. */
export async function logoVisionJpeg(bytes: Buffer, config: BrandPaletteConfig = brandPalette): Promise<Buffer> {
  return sharp(bytes)
    .rotate()
    .resize({ width: config.visionLongSide, height: config.visionLongSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: stillStyle.sweepGrayHex })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** True when the reading should go to the vision recipe. */
export function paletteNeedsVision(reading: PaletteReading): boolean {
  return reading.ambiguity.length > 0 && reading.candidates.length > 0;
}

/**
 * The brand_palette_namer answer, sent as the strict tool schema (every
 * field required). Hexes are checked against the candidates afterwards,
 * so a pattern is not needed here.
 */
export const PaletteNaming = z.object({
  colors: z.array(z.object({ hex: z.string(), name: z.string() })),
});
export type PaletteNaming = z.infer<typeof PaletteNaming>;

/** What the recipe is sent next to the logo image. */
export function paletteNamingPayload(reading: PaletteReading, config: BrandPaletteConfig = brandPalette) {
  return {
    maxColors: config.maxColors,
    candidates: reading.candidates.map((c) => ({ hex: c.hex, share: c.share })),
  };
}

/** A model color name as plain words: letters and spaces only, bounded. */
export function plainColorName(text: string, config: BrandPaletteConfig = brandPalette): string {
  return text
    .replace(/[^\p{L} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, config.nameMaxLength)
    .trim();
}

function pixelName(color: PaletteColor): string {
  const [r, g, b] = labToRgb(color.lab);
  return colorNameOf(r, g, b);
}

function suggestionOf(
  picked: ReadonlyArray<{ color: PaletteColor; name: string }>,
  source: BrandKitSuggestion["source"],
  ambiguous: boolean,
  config: BrandPaletteConfig,
): BrandKitSuggestion {
  const background = suggestBackground(
    picked.map((p) => p.color),
    config,
  );
  return {
    colors: picked.map(({ color, name }) => ({
      hex: color.hex,
      name,
      share: color.share,
      text: textColorFor(color.hex, config),
    })),
    background: { hex: background, text: textColorFor(background, config) },
    source,
    ambiguous,
  };
}

/** The suggestion from the pixels alone, with coarse color names. */
export function suggestionFromReading(reading: PaletteReading, config: BrandPaletteConfig = brandPalette): BrandKitSuggestion {
  return suggestionOf(
    reading.colors.map((color) => ({ color, name: pixelName(color) })),
    "pixels",
    reading.ambiguity.length > 0,
    config,
  );
}

/**
 * Merges the vision answer into the reading: only hexes that are measured
 * candidates count (case does not matter), each once, at most maxColors,
 * in the model's order. An answer with no usable color leaves the pixel
 * suggestion as it was.
 */
export function applyPaletteNaming(
  reading: PaletteReading,
  answer: unknown,
  config: BrandPaletteConfig = brandPalette,
): BrandKitSuggestion {
  const parsed = PaletteNaming.safeParse(answer);
  if (!parsed.success) {
    return suggestionFromReading(reading, config);
  }
  const byHex = new Map(reading.candidates.map((c) => [c.hex, c]));
  const picked: Array<{ color: PaletteColor; name: string }> = [];
  for (const entry of parsed.data.colors) {
    const color = byHex.get(entry.hex.trim().toUpperCase());
    if (!color || picked.some((p) => p.color.hex === color.hex)) {
      continue;
    }
    picked.push({ color, name: plainColorName(entry.name, config) || pixelName(color) });
    if (picked.length >= config.maxColors) {
      break;
    }
  }
  if (picked.length === 0) {
    return suggestionFromReading(reading, config);
  }
  return suggestionOf(picked, "vision", true, config);
}
