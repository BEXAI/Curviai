/**
 * Product inventory (docs/phases/PHASE_13.md, inventory stage). Runs first on
 * every uploaded photo: the photo's cutout is split into its significant
 * connected pieces, and each piece gets deterministic facts (box, area
 * share, shape, dominant color). Intake's product list is then matched onto
 * the pieces by box overlap, and the product the pack features is picked by
 * a fixed order of rules that never rests on one model answer alone:
 *
 * 1. in the box photos keep every piece;
 * 2. exactly one intake product the model says matches the note, when it
 *    maps to pieces, and, if the note names a color, only when those pieces
 *    also pass the note's color filter (otherwise ambiguous);
 * 3. the note alone: the single piece whose color (and intake label, when
 *    matched) fits what the note asks for and not what it excludes;
 * 4. exactly one piece: that one;
 * 5. exactly one intake product mapping to pieces: those pieces (a product
 *    in several parts, props around it removed);
 * 6. otherwise ambiguous: the pack stops before any paid generation.
 *
 * Everything here is pure and deterministic: same pixels and same answers,
 * same result. The color table is fixed data, not a prompt or a model id.
 */
import { CUTOUT_ALPHA_THRESHOLD, maskComponents, significantArea, NOISE_AREA_SHARE } from "./isolate";
import type { BBox } from "./mask";
import type { RawImage } from "./raw";
import type { IntakeProduct, NormalizedBox, SellerIntent } from "./schemas";

/** Coarse color names, in the order ties are broken. */
export const COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
  "black",
  "white",
  "gray",
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

/** Hue bands in degrees (start inclusive, end exclusive) for saturated
 * colors; red wraps around 0. */
const HUE_BANDS: ReadonlyArray<{ name: ColorName; from: number; to: number }> = [
  { name: "red", from: 0, to: 15 },
  { name: "orange", from: 15, to: 40 },
  { name: "yellow", from: 40, to: 70 },
  { name: "green", from: 70, to: 160 },
  { name: "teal", from: 160, to: 195 },
  { name: "blue", from: 195, to: 255 },
  { name: "purple", from: 255, to: 290 },
  { name: "pink", from: 290, to: 345 },
  { name: "red", from: 345, to: 360 },
];

/** Value under this is black, whatever the hue. */
const BLACK_MAX_VALUE = 0.2;
/** Saturation under this is white or gray. */
const GRAY_MAX_SATURATION = 0.15;
/** Unsaturated pixels at or above this value are white, below it gray. */
const WHITE_MIN_VALUE = 0.8;
/** Orange hues this dark are brown. */
const BROWN_MAX_VALUE = 0.6;
/** Pale reds (low saturation, bright) read as pink. */
const PINK_MAX_SATURATION = 0.5;
const PINK_MIN_VALUE = 0.7;

/** Alpha at or above this is an opaque product pixel for color. */
export const OPAQUE_ALPHA = 128;

/** A piece is tall when height over width is at least this, wide when it is
 * at most the inverse, square otherwise. */
export const TALL_ASPECT = 1.25;

/** A color counts as one of a piece's colors at this share of its opaque
 * pixels, besides the dominant one. */
export const SECONDARY_COLOR_SHARE = 0.25;

/** A chosen piece holding at least this share of a color the note excludes
 * (and does not ask for) is taken to be two products touching. */
export const EXCLUDED_COLOR_SHARE = 0.25;

/** An intake box and a piece belong together when at least this share of
 * one lies inside the other (containment either way). */
export const MATCH_CONTAINMENT = 0.5;

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rf) h = 60 * (((gf - bf) / d) % 6);
    else if (max === gf) h = 60 * ((bf - rf) / d + 2);
    else h = 60 * ((rf - gf) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** The coarse color name of one pixel, from the fixed hue table with value
 * and saturation rules for black, white, gray, brown and pale pink. */
export function colorNameOf(r: number, g: number, b: number): ColorName {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < BLACK_MAX_VALUE) return "black";
  if (s < GRAY_MAX_SATURATION) return v >= WHITE_MIN_VALUE ? "white" : "gray";
  const band = HUE_BANDS.find((entry) => h >= entry.from && h < entry.to) ?? HUE_BANDS[0];
  if (band.name === "orange" && v < BROWN_MAX_VALUE) return "brown";
  if (band.name === "red" && s < PINK_MAX_SATURATION && v >= PINK_MIN_VALUE) return "pink";
  return band.name;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

export type ShapeClass = "tall" | "wide" | "square";

/** One significant piece of a photo's cutout. */
export interface InventoryObject {
  /** 0 based, in the row major order of each piece's first pixel. */
  index: number;
  /** Normalized to 0..1 of the cutout, the same convention as NormalizedBox. */
  box: NormalizedBox;
  /** Pixel box in the cutout. */
  pixelBox: BBox;
  /** Share of the whole image's area the piece covers. */
  areaShare: number;
  /** Height over width of the piece's box. */
  aspectRatio: number;
  shape: ShapeClass;
  color: {
    /** Mean color of the opaque pixels of the dominant color name. */
    hex: string;
    name: ColorName;
    /** Share of the piece's opaque pixels per color name (0..1). */
    shares: Partial<Record<ColorName, number>>;
  };
}

export interface CutoutInventory {
  width: number;
  height: number;
  objects: InventoryObject[];
  /** Pieces under the noise threshold, never counted as products. */
  noisePieces: number;
}

export function shapeOf(aspectRatio: number): ShapeClass {
  if (aspectRatio >= TALL_ASPECT) return "tall";
  if (aspectRatio <= 1 / TALL_ASPECT) return "wide";
  return "square";
}

/**
 * The significant pieces of a cutout (alpha above CUTOUT_ALPHA_THRESHOLD, at
 * least NOISE_AREA_SHARE of the image, the same rules isolation uses) with
 * their deterministic facts.
 */
export function analyzeInventory(cutout: RawImage, opts: { noiseShare?: number } = {}): CutoutInventory {
  const { width, height, data } = cutout;
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  const { labels, components } = maskComponents({ data: alpha, width, height }, CUTOUT_ALPHA_THRESHOLD);
  const minArea = significantArea(width, height, opts.noiseShare ?? NOISE_AREA_SHARE);
  const significant = components.filter((c) => c.area >= minArea);
  const slot = new Int32Array(components.length + 1).fill(-1);
  significant.forEach((c, i) => {
    slot[c.label] = i;
  });
  const names = COLOR_NAMES.length;
  // Per piece and color name: opaque pixel count and RGB sums; plus every
  // pixel as a fallback for pieces with no opaque pixel at all.
  const counts = new Float64Array(significant.length * names);
  const sums = new Float64Array(significant.length * names * 3);
  const opaque = new Float64Array(significant.length);
  for (let p = 0; p < labels.length; p++) {
    const s = slot[labels[p]];
    if (s >= 0 && data[p * 4 + 3] >= OPAQUE_ALPHA) opaque[s]++;
  }
  for (let p = 0; p < labels.length; p++) {
    const s = slot[labels[p]];
    if (s < 0) continue;
    const o = p * 4;
    if (opaque[s] > 0 && data[o + 3] < OPAQUE_ALPHA) continue;
    const name = COLOR_NAMES.indexOf(colorNameOf(data[o], data[o + 1], data[o + 2]));
    const k = s * names + name;
    counts[k]++;
    sums[k * 3] += data[o];
    sums[k * 3 + 1] += data[o + 1];
    sums[k * 3 + 2] += data[o + 2];
  }
  const objects = significant.map((c, i): InventoryObject => {
    let total = 0;
    let best = 0;
    for (let n = 0; n < names; n++) {
      total += counts[i * names + n];
      if (counts[i * names + n] > counts[i * names + best]) best = n;
    }
    const shares: Partial<Record<ColorName, number>> = {};
    for (let n = 0; n < names; n++) {
      const count = counts[i * names + n];
      if (count > 0 && total > 0) shares[COLOR_NAMES[n]] = round4(count / total);
    }
    const k = i * names + best;
    const n = Math.max(1, counts[k]);
    const aspectRatio = c.bbox.height / c.bbox.width;
    return {
      index: i,
      box: {
        x: round4(c.bbox.left / width),
        y: round4(c.bbox.top / height),
        width: round4(c.bbox.width / width),
        height: round4(c.bbox.height / height),
      },
      pixelBox: c.bbox,
      areaShare: round4(c.area / (width * height)),
      aspectRatio: round4(aspectRatio),
      shape: shapeOf(aspectRatio),
      color: {
        hex: toHex(sums[k * 3] / n, sums[k * 3 + 1] / n, sums[k * 3 + 2] / n),
        name: COLOR_NAMES[best],
        shares,
      },
    };
  });
  return { width, height, objects, noisePieces: components.length - significant.length };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Color names a piece shows: the dominant one plus any other at
 * SECONDARY_COLOR_SHARE or more. */
export function objectColors(object: InventoryObject): Set<ColorName> {
  const colors = new Set<ColorName>([object.color.name]);
  for (const [name, share] of Object.entries(object.color.shares)) {
    if ((share ?? 0) >= SECONDARY_COLOR_SHARE) colors.add(name as ColorName);
  }
  return colors;
}

// ---------------------------------------------------------------------------
// The seller's note, read deterministically.

/** Words sellers use for each coarse color. */
const COLOR_WORDS: Readonly<Record<string, ColorName>> = {
  red: "red",
  crimson: "red",
  scarlet: "red",
  maroon: "red",
  burgundy: "red",
  cherry: "red",
  orange: "orange",
  amber: "orange",
  coral: "orange",
  yellow: "yellow",
  gold: "yellow",
  golden: "yellow",
  lemon: "yellow",
  mustard: "yellow",
  green: "green",
  lime: "green",
  olive: "green",
  mint: "green",
  emerald: "green",
  teal: "teal",
  turquoise: "teal",
  cyan: "teal",
  aqua: "teal",
  blue: "blue",
  navy: "blue",
  cobalt: "blue",
  azure: "blue",
  purple: "purple",
  violet: "purple",
  lavender: "purple",
  lilac: "purple",
  plum: "purple",
  pink: "pink",
  magenta: "pink",
  fuchsia: "pink",
  rose: "pink",
  brown: "brown",
  tan: "brown",
  beige: "brown",
  chocolate: "brown",
  bronze: "brown",
  black: "black",
  white: "white",
  ivory: "white",
  cream: "white",
  gray: "gray",
  grey: "gray",
  silver: "gray",
  charcoal: "gray",
};

/** Words that turn a clause of the note into something to leave out. */
const EXCLUDE_WORDS: ReadonlySet<string> = new Set([
  "delete",
  "deleted",
  "remove",
  "removed",
  "removing",
  "without",
  "exclude",
  "excluding",
  "except",
  "erase",
  "drop",
  "hide",
  "rid",
  "no",
  "not",
  "dont",
  "lose",
  "omit",
  "ignore",
]);

/** Words that say nothing about which product is meant. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "but",
  "only",
  "just",
  "one",
  "ones",
  "this",
  "that",
  "these",
  "those",
  "its",
  "with",
  "from",
  "for",
  "into",
  "out",
  "off",
  "all",
  "any",
  "both",
  "fully",
  "completely",
  "entirely",
  "entire",
  "whole",
  "please",
  "keep",
  "show",
  "use",
  "want",
  "need",
  "feature",
  "featured",
  "featuring",
  "focus",
  "make",
  "sure",
  "also",
  "too",
  "get",
  "leave",
  "take",
  "crop",
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "pictures",
  "shot",
  "shots",
  "background",
  "product",
  "products",
  "item",
  "items",
  "thing",
  "things",
  "other",
  "left",
  "right",
  "side",
  "you",
  "our",
  "your",
  "are",
  "was",
  "has",
  "have",
  "should",
  "would",
  "could",
  "can",
  "will",
  "there",
  "here",
  "them",
  "they",
  "listing",
]);

/** What the note asks for and leaves out, in deterministic terms. */
export interface NoteSignals {
  wantColors: ColorName[];
  excludeColors: ColorName[];
  /** Product words only on the wanted side (words on both sides, such as
   * "gatorade" in "blue Gatorade, not the red Gatorade", tell nothing). */
  wantWords: string[];
  excludeWords: string[];
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/** Singular form, so "bottles" matches "bottle". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("es") && /(ch|sh|x|s)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function productWords(words: readonly string[]): string[] {
  return words
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !EXCLUDE_WORDS.has(w) && !(w in COLOR_WORDS))
    .map(stem);
}

function colorsIn(words: readonly string[]): ColorName[] {
  return words.filter((w) => w in COLOR_WORDS).map((w) => COLOR_WORDS[w]);
}

/**
 * Reads the note and the intent intake parsed from it. The raw note is split
 * into clauses on punctuation, "but" and "then"; in each clause the words
 * from the first exclusion word ("delete", "remove", "without", "not" and
 * the like) on list what to leave out, the words before it what to feature. featureOnly adds to
 * the wanted side and exclude to the other. A color or word on both sides
 * is dropped from both, since it cannot tell the products apart. The note
 * is untrusted text and is only ever matched against fixed word lists.
 */
export function noteSignals(note: string | null | undefined, intent?: SellerIntent | null): NoteSignals {
  const want: string[] = [];
  const exclude: string[] = [];
  const text = (note ?? "").slice(0, 2000);
  for (const clause of text.split(/[.,;:!?\n()]+|\bbut\b|\bthen\b/i)) {
    const words = wordsOf(clause);
    const cut = words.findIndex((w) => EXCLUDE_WORDS.has(w));
    want.push(...(cut < 0 ? words : words.slice(0, cut)));
    if (cut >= 0) exclude.push(...words.slice(cut));
  }
  if (intent?.featureOnly) want.push(...wordsOf(intent.featureOnly));
  for (const item of intent?.exclude ?? []) exclude.push(...wordsOf(item));

  const wantColorSet = new Set(colorsIn(want));
  const excludeColorSet = new Set(colorsIn(exclude));
  const wantWordSet = new Set(productWords(want));
  const excludeWordSet = new Set(productWords(exclude));
  const onlyIn = <T>(a: Set<T>, b: Set<T>): T[] => [...a].filter((x) => !b.has(x)).sort();
  return {
    wantColors: onlyIn(wantColorSet, excludeColorSet),
    excludeColors: onlyIn(excludeColorSet, wantColorSet),
    wantWords: onlyIn(wantWordSet, excludeWordSet),
    excludeWords: onlyIn(excludeWordSet, wantWordSet),
  };
}

function hasSignal(signals: NoteSignals): boolean {
  return (
    signals.wantColors.length + signals.excludeColors.length + signals.wantWords.length + signals.excludeWords.length > 0
  );
}

function namesColor(signals: NoteSignals): boolean {
  return signals.wantColors.length + signals.excludeColors.length > 0;
}

// ---------------------------------------------------------------------------
// Reconciling intake's products with the pieces.

function area(box: NormalizedBox): number {
  return box.width * box.height;
}

function overlap(a: NormalizedBox, b: NormalizedBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Share of box a lying inside box b. */
export function containment(a: NormalizedBox, b: NormalizedBox): number {
  const size = area(a);
  return size > 0 ? overlap(a, b) / size : 0;
}

export interface ProductMatch {
  /** Per piece, the intake product it belongs to best, or null. */
  productOf: Array<number | null>;
  /** Per intake product, the pieces it maps to (the piece inside the
   * product's box, or the product's box inside the piece). */
  objectsOf: number[][];
  /** Per piece, how many intake products lie mostly inside it: two or more
   * means products touching in one piece. */
  productsInside: number[];
}

/**
 * Matches intake products to pieces by box overlap. A piece and a product
 * match when at least MATCH_CONTAINMENT of the piece's box lies inside the
 * product's box, or of the product's box inside the piece's (a loose model
 * box around a piece, or a piece holding two touching products). A piece's
 * label comes from the product with the largest mutual containment.
 */
export function matchProducts(objects: readonly InventoryObject[], products: readonly IntakeProduct[]): ProductMatch {
  const objectsOf: number[][] = products.map(() => []);
  const productOf: Array<number | null> = [];
  const productsInside: number[] = [];
  for (const object of objects) {
    let best: number | null = null;
    let bestScore = 0;
    let inside = 0;
    products.forEach((product, p) => {
      const pieceIn = containment(object.box, product.box);
      const productIn = containment(product.box, object.box);
      if (productIn >= MATCH_CONTAINMENT) inside++;
      if (pieceIn >= MATCH_CONTAINMENT || productIn >= MATCH_CONTAINMENT) {
        objectsOf[p].push(object.index);
        const score = pieceIn + productIn;
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    });
    productOf.push(best);
    productsInside.push(inside);
  }
  return { productOf, objectsOf, productsInside };
}

// ---------------------------------------------------------------------------
// Picking the product.

export type InventoryRule =
  | "in_the_box"
  | "model"
  | "note"
  | "single_object"
  | "single_product"
  | "ambiguous"
  | "conflict"
  | "none";

export interface InventoryDecision {
  rule: InventoryRule;
  /** Piece indexes the pack features; empty when ambiguous or none. */
  featured: number[];
  /** Piece indexes removed from every image. */
  removed: number[];
  /** True when the featured piece holds another product too (touching
   * products, or a large share of a color the note excludes): every shot of
   * the photo is refused at no charge. */
  touching: boolean;
}

export interface InventoryChoiceInput {
  objects: readonly InventoryObject[];
  /** Intake's products for this photo (version 3), empty when none. */
  products: readonly IntakeProduct[];
  signals: NoteSignals;
  /** The photo shows several items on purpose (the in the box role). */
  multiItem?: boolean;
}

function passesNote(object: InventoryObject, label: string | null, signals: NoteSignals): boolean {
  const colors = objectColors(object);
  const labelWords = new Set(productWords(wordsOf(label ?? "")));
  if (signals.excludeColors.includes(object.color.name)) return false;
  if (label && signals.excludeWords.some((w) => labelWords.has(w))) return false;
  const wantedByColor = signals.wantColors.length === 0 || signals.wantColors.some((c) => colors.has(c));
  if (!wantedByColor) return false;
  if (signals.wantWords.length === 0) return true;
  // Without an intake label only a color can speak for the piece.
  return label ? signals.wantWords.some((w) => labelWords.has(w)) : signals.wantColors.length > 0;
}

function holdsExcludedColor(object: InventoryObject, signals: NoteSignals): boolean {
  return signals.excludeColors.some(
    (c) => !signals.wantColors.includes(c) && (object.color.shares[c] ?? 0) >= EXCLUDED_COLOR_SHARE,
  );
}

/** Picks the pieces a photo's pack features; see the module comment for the
 * order of the rules. */
export function chooseInventoryTarget(input: InventoryChoiceInput): InventoryDecision {
  const { objects, products, signals } = input;
  const all = objects.map((o) => o.index);
  const decide = (rule: InventoryRule, featured: number[], touching = false): InventoryDecision => ({
    rule,
    featured: [...featured].sort((a, b) => a - b),
    removed: all.filter((i) => !featured.includes(i)),
    touching,
  });
  const undecided = (rule: InventoryRule): InventoryDecision => ({ rule, featured: [], removed: [], touching: false });
  if (objects.length === 0) return undecided("none");
  if (input.multiItem) return decide("in_the_box", all);

  const match = matchProducts(objects, products);
  const labelOf = (i: number): string | null => {
    const p = match.productOf[i];
    return p === null ? null : products[p].label;
  };
  const noteCandidates = hasSignal(signals)
    ? objects.filter((o) => passesNote(o, labelOf(o.index), signals)).map((o) => o.index)
    : null;
  const merged = (picked: number[]) => picked.some((i) => match.productsInside[i] >= 2);
  const touchingOf = (picked: number[]) =>
    merged(picked) || picked.some((i) => holdsExcludedColor(objects[i], signals));

  // 2. The model's single yes, checked against the note's colors.
  const yes = products
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p.matchesIntent === "yes" && match.objectsOf[i].length > 0);
  if (yes.length === 1) {
    const picked = match.objectsOf[yes[0].i];
    // A piece holding two products has no one color to check: the pick is
    // right, and the piece cannot be separated.
    if (merged(picked)) {
      return decide("model", picked, true);
    }
    if (namesColor(signals) && !picked.every((i) => noteCandidates?.includes(i))) {
      return undecided("conflict");
    }
    return decide("model", picked, touchingOf(picked));
  }
  // 3. The note alone picks exactly one piece.
  if (noteCandidates && noteCandidates.length === 1) {
    return decide("note", noteCandidates, touchingOf(noteCandidates));
  }
  // 4. One piece. When it holds two of intake's products and nothing says
  // which one is meant, it stays ambiguous, as before the inventory.
  if (objects.length === 1) {
    const intentGiven = hasSignal(signals) || products.some((p) => p.matchesIntent === "yes");
    if (merged(all) && !intentGiven) return undecided("ambiguous");
    return decide("single_object", all, touchingOf(all));
  }
  // 5. Intake saw one product: its pieces, props around it removed.
  if (products.length === 1 && match.objectsOf[0].length > 0) {
    const picked = match.objectsOf[0];
    if (namesColor(signals) && !picked.every((i) => noteCandidates?.includes(i))) {
      return undecided("conflict");
    }
    return decide("single_product", picked, touchingOf(picked));
  }
  return undecided("ambiguous");
}

// ---------------------------------------------------------------------------
// The record kept on the job.

export type InventoryItemStatus = "featured" | "removed" | "kept";

export interface InventoryItemRecord {
  label: string;
  labelSource: "intake" | "deterministic";
  box: NormalizedBox;
  areaShare: number;
  aspectRatio: number;
  shape: ShapeClass;
  colorHex: string;
  colorName: ColorName;
  status: InventoryItemStatus;
}

/** One photo's inventory as stored in generation_jobs.inventory. */
export interface PhotoInventory {
  mediaId: string;
  items: InventoryItemRecord[];
  /** How many products intake counted (its product list, else its
   * distinctProducts), or null without an intake answer for the photo. */
  intakeCount: number | null;
  countMatch: boolean | null;
  /** Piece indexes no intake product matched. */
  unmatchedItems: number[];
  /** Intake product labels that matched no piece. */
  unmatchedProducts: string[];
  rule: InventoryRule;
  touching: boolean;
}

export interface JobInventory {
  version: 1;
  photos: PhotoInventory[];
}

/** The fallback label of a piece no intake product matched. */
export function deterministicLabel(object: InventoryObject): string {
  return `${object.color.name} ${object.shape} object`;
}

/** A piece's label: intake's when a product matched it, else deterministic. */
export function itemLabel(object: InventoryObject, products: readonly IntakeProduct[], match: ProductMatch): string {
  const p = match.productOf[object.index];
  return p === null ? deterministicLabel(object) : products[p].label;
}

/** The stored record of one photo: every piece with its label and status,
 * and how the pieces agree with intake. */
export function inventoryRecord(args: {
  mediaId: string;
  inventory: CutoutInventory;
  products: readonly IntakeProduct[];
  /** Intake's distinctProducts for the photo, when it answered. */
  distinctProducts?: number | null;
  decision: InventoryDecision;
}): PhotoInventory {
  const { inventory, products, decision } = args;
  const match = matchProducts(inventory.objects, products);
  const decided = decision.featured.length > 0;
  const items = inventory.objects.map((o): InventoryItemRecord => {
    const p = match.productOf[o.index];
    return {
      label: itemLabel(o, products, match),
      labelSource: p === null ? "deterministic" : "intake",
      box: o.box,
      areaShare: o.areaShare,
      aspectRatio: o.aspectRatio,
      shape: o.shape,
      colorHex: o.color.hex,
      colorName: o.color.name,
      status:
        !decided || decision.rule === "in_the_box"
          ? "kept"
          : decision.featured.includes(o.index)
            ? "featured"
            : "removed",
    };
  });
  const intakeCount =
    products.length > 0 ? products.length : args.distinctProducts === undefined ? null : args.distinctProducts;
  return {
    mediaId: args.mediaId,
    items,
    intakeCount,
    countMatch: intakeCount === null ? null : intakeCount === items.length,
    unmatchedItems: match.productOf.flatMap((p, i) => (p === null ? [i] : [])),
    unmatchedProducts: products.filter((_, i) => match.objectsOf[i].length === 0).map((p) => p.label),
    rule: decision.rule,
    touching: decision.touching,
  };
}

/** The union of normalized boxes. */
export function unionBox(boxes: readonly NormalizedBox[]): NormalizedBox | null {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
