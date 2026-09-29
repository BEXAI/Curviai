/**
 * Seller output options (docs/phases/PHASE_15.md): what Curvi does to the
 * seller's photos. One module, pure and client safe (no sharp, no node APIs),
 * shared by the form, the API, the services, the demo, the runner, the
 * marketing resizer and the tests.
 *
 * Two layers and one rule:
 * - Each photo is removed (cut out and placed on the chosen color, today's
 *   pack) or kept (shipped as itself, only resized, converted to sRGB or
 *   given flat added space).
 * - Extra images (scenes, backdrops, the transparent PNG, graphics and cards)
 *   are made from a cut out copy and never touch a kept photo.
 * - The background color is resolved per spec at render time, and a spec
 *   whose registry rule requires white always gets white.
 *
 * Colors, sizes and limits come from the seed and the registry (CLAUDE.md
 * rule 2). The P0 schema accepts only P0 fields; each P1 field joins it in
 * the pull request that renders it.
 */
import { z } from "zod";
import {
  allowsAddedBorders,
  dimensionBounds,
  hasSpec,
  getSpec,
  isExactSize,
  refusesOverlays,
  requiresWhiteBackground,
  type ChannelSpec,
} from "@curvi/specs";
import type { Shot } from "./schemas";
import { MAX_BRAND_COLORS } from "./seed/brand";
import { backgroundSwatches, canvasDefaults, originalFit, stillStyle, type BackgroundSwatchKey } from "./seed/templates";

/** A six digit hex color, like #1F2A44. */
export const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The most a source is scaled up for any output (PHASE_13.md item 7). Kept
 * photos use the same cap (PHASE_15 control 6). */
export const MAX_SOURCE_UPSCALE = 1.5;

/** Reason recorded in skipped for a shot in an extra family the seller turned off. */
export const SELLER_OFF_REASON = "turned off by the seller";

/** Reason recorded in skipped for a kept photo too small for a spec within the enlarge cap. */
export const SOURCE_TOO_SMALL_REASON = "source too small for this channel";

/** Reason recorded in skipped for a kept photo intake saw added text,
 * borders, watermarks or stickers on, left out of a spec that refuses them
 * (refusesOverlays, PHASE_15 P1). */
export const ADDED_OVERLAYS_REASON = "added text or overlays on the photo";

/** Seeded swatch keys, in dropdown order. */
export const SWATCH_KEYS = Object.keys(backgroundSwatches) as [BackgroundSwatchKey, ...BackgroundSwatchKey[]];

/** The swatch every pack uses unless the seller picks another color. */
export const DEFAULT_SWATCH_KEY: BackgroundSwatchKey = "white";

export const ColorChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swatch"), key: z.enum(SWATCH_KEYS) }).strict(),
  z.object({ kind: z.literal("brand"), index: z.number().int().min(0).max(MAX_BRAND_COLORS - 1) }).strict(),
  z.object({ kind: z.literal("custom"), hex: z.string().regex(HEX) }).strict(),
]);
export type ColorChoice = z.infer<typeof ColorChoice>;

/** The switchable extra image families (PHASE_15 control 5). */
export const EXTRA_FAMILY_KEYS = ["scenes", "backdrops", "transparentPng", "graphics", "cards"] as const;
export type ExtraFamily = (typeof EXTRA_FAMILY_KEYS)[number];

/** Shot types per extra family. A shot type in no family is never switchable. */
export const EXTRA_FAMILIES: Readonly<Record<ExtraFamily, readonly Shot["type"][]>> = {
  scenes: ["lifestyle", "shopify_hero"],
  backdrops: ["sweep_gray", "sweep_brand"],
  transparentPng: ["cutout_png"],
  graphics: ["infographic", "dimensions", "in_the_box", "comparison"],
  cards: ["social_1x1", "social_4x5", "social_9x16", "social_2x3", "aplus_banner"],
};

/** Shot types the seller can never switch off. */
export const NEVER_SWITCHABLE_SHOT_TYPES: readonly Shot["type"][] = [
  "amazon_main",
  "alt_angle_white",
  "collection_thumb",
  "original_photo",
];

/** The extra family a shot type belongs to, or null when it is not switchable. */
export function extraFamilyOf(type: Shot["type"]): ExtraFamily | null {
  for (const family of EXTRA_FAMILY_KEYS) {
    if (EXTRA_FAMILIES[family].includes(type)) {
      return family;
    }
  }
  return null;
}

export const LOOK_KEYS = ["marketplace", "keep_photo", "brand"] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
/** A look the server derives: a preset key, or custom when no preset matches. */
export type Look = LookKey | "custom";

const Background = z.enum(["remove", "keep"]);
const Fit = z.enum(["auto", "pad"]);

const ExtrasInput = z
  .object({
    scenes: z.boolean(),
    backdrops: z.boolean(),
    transparentPng: z.boolean(),
    graphics: z.boolean(),
    cards: z.boolean(),
  })
  .partial()
  .strict();

const Extras = z
  .object({
    scenes: z.boolean(),
    backdrops: z.boolean(),
    transparentPng: z.boolean(),
    graphics: z.boolean(),
    cards: z.boolean(),
  })
  .strict();
export type OutputExtras = z.infer<typeof Extras>;

/**
 * What a request may send. P0 fields only, strict: an unknown key or a P1
 * value (fit crop, edge_match, sceneCount) is refused.
 */
export const OutputOptionsInput = z
  .object({
    v: z.literal(1).default(1),
    lookBase: z.enum(LOOK_KEYS).optional(),
    background: Background.default("remove"),
    color: ColorChoice.default({ kind: "swatch", key: DEFAULT_SWATCH_KEY }),
    fit: Fit.default("auto"),
    extras: ExtrasInput.default({}),
  })
  .strict();
/** The request shape, before defaults. */
export type OutputOptionsInput = z.input<typeof OutputOptionsInput>;

/** Options after normalization: every field filled, extras complete. */
export interface NormalizedOutputOptions {
  v: 1;
  lookBase?: LookKey;
  background: "remove" | "keep";
  color: ColorChoice;
  fit: "auto" | "pad";
  extras: OutputExtras;
}

/** The choices a look fixes: normalized options without lookBase. */
export type OutputChoices = Omit<NormalizedOutputOptions, "lookBase">;

function allExtras(on: boolean): OutputExtras {
  return { scenes: on, backdrops: on, transparentPng: on, graphics: on, cards: on };
}

/**
 * Parses and fills a request's options. Missing extras follow the
 * background: all on with remove, all off with keep. An absent options
 * object normalizes to today's pack exactly. Throws a ZodError on anything
 * the P0 schema refuses.
 */
export function normalizeOutputOptions(input?: OutputOptionsInput | null): NormalizedOutputOptions {
  const parsed = OutputOptionsInput.parse(input ?? {});
  const extras = { ...allExtras(parsed.background === "remove"), ...parsed.extras };
  return {
    v: 1,
    ...(parsed.lookBase !== undefined ? { lookBase: parsed.lookBase } : {}),
    background: parsed.background,
    color: parsed.color,
    fit: parsed.fit,
    extras,
  };
}

/** The three looks, defined once. The form's cards start from these. */
export const LOOK_PRESETS: Readonly<Record<LookKey, OutputChoices>> = {
  marketplace: {
    v: 1,
    background: "remove",
    color: { kind: "swatch", key: DEFAULT_SWATCH_KEY },
    fit: "auto",
    extras: allExtras(true),
  },
  keep_photo: {
    v: 1,
    background: "keep",
    color: { kind: "swatch", key: DEFAULT_SWATCH_KEY },
    fit: "auto",
    extras: allExtras(false),
  },
  brand: {
    v: 1,
    background: "remove",
    color: { kind: "brand", index: 0 },
    fit: "auto",
    extras: allExtras(true),
  },
};

/** Today's pack: Marketplace ready. */
export const DEFAULT_OUTPUT_OPTIONS: NormalizedOutputOptions = normalizeOutputOptions({});

/** Canonical JSON: object keys sorted at every depth, so key order never matters. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function choicesOf(options: NormalizedOutputOptions | OutputChoices): OutputChoices {
  return { v: 1, background: options.background, color: options.color, fit: options.fit, extras: options.extras };
}

/** The look the choices amount to: the preset key on an exact match, otherwise custom. */
export function lookOf(options: NormalizedOutputOptions | OutputChoices): Look {
  const key = canonicalJson(choicesOf(options));
  for (const look of LOOK_KEYS) {
    if (canonicalJson(LOOK_PRESETS[look]) === key) {
      return look;
    }
  }
  return "custom";
}

/** Fields createJob adds when it resolves the options. */
const RESOLVED_FIELDS = ["look", "colorHex", "brandSweepHex", "keepMediaIds"] as const;

/**
 * Canonical JSON of the normalized choices with sorted keys, leaving out
 * lookBase and every resolved field, for idempotency: absent options and
 * explicit defaults give the same key. Accepts a request's options, a
 * normalized object or a stored resolved one. Throws on invalid options.
 */
export function outputOptionsKey(input?: OutputOptionsInput | NormalizedOutputOptions | ResolvedOutputOptions | null): string {
  let raw: Record<string, unknown> = {};
  if (input && typeof input === "object") {
    raw = { ...(input as Record<string, unknown>) };
    delete raw.lookBase;
    for (const field of RESOLVED_FIELDS) {
      delete raw[field];
    }
  }
  return canonicalJson(choicesOf(normalizeOutputOptions(raw as OutputOptionsInput)));
}

/**
 * The options a job carries once createJob resolves them: the normalized
 * choices plus the server derived look, the color snapshot, the brand sweep
 * snapshot and the R2 keys of the kept photos. JSON safe, since it crosses
 * the generate-shot subtask boundary. The runner parses the payload with
 * this schema and fails the job closed on anything else.
 */
export const ResolvedOutputOptions = z
  .object({
    v: z.literal(1),
    lookBase: z.enum(LOOK_KEYS).optional(),
    look: z.enum([...LOOK_KEYS, "custom"]),
    background: Background,
    color: ColorChoice,
    fit: Fit,
    extras: Extras,
    colorHex: z.string().regex(HEX),
    brandSweepHex: z.string().regex(HEX),
    keepMediaIds: z.array(z.string().min(1).max(1024)),
  })
  .strict();
export type ResolvedOutputOptions = z.infer<typeof ResolvedOutputOptions>;

/** What createJob snapshots next to the normalized choices. */
export interface OutputOptionsSnapshot {
  colorHex: string;
  brandSweepHex: string;
  keepMediaIds: string[];
}

/** Builds the resolved options from normalized choices and createJob's snapshot. */
export function resolveOutputOptions(options: NormalizedOutputOptions, snapshot: OutputOptionsSnapshot): ResolvedOutputOptions {
  return ResolvedOutputOptions.parse({
    ...options,
    look: lookOf(options),
    colorHex: snapshot.colorHex.toUpperCase(),
    brandSweepHex: snapshot.brandSweepHex.toUpperCase(),
    keepMediaIds: [...snapshot.keepMediaIds],
  });
}

/**
 * The hex a color choice resolves to, upper case: a seeded swatch, the brand
 * kit color at the index, or the custom value. null when the brand kit has
 * no color at that index (createJob answers invalid_options). Whether the
 * plan includes brand kits is createJob's check, not this one.
 */
export function resolveColorHex(choice: ColorChoice, brandColors: readonly string[]): string | null {
  switch (choice.kind) {
    case "swatch":
      return backgroundSwatches[choice.key].hex.toUpperCase();
    case "brand": {
      const hex = brandColors[choice.index];
      return hex !== undefined && HEX.test(hex) ? hex.toUpperCase() : null;
    }
    case "custom":
      return choice.hex.toUpperCase();
  }
}

/** The photos with Keep: every photo when the pack keeps its backgrounds (P0). */
export function keepMediaIdsFor(options: Pick<NormalizedOutputOptions, "background">, photoIds: readonly string[]): string[] {
  return options.background === "keep" ? [...photoIds] : [];
}

/** One photo of the pack as the planner and the estimate see it. */
export interface PlanPhoto {
  /** R2 key, or a synthetic id in the estimate. */
  id: string;
  /** Photographed angle or seller role, when known ("front", "packaging"). */
  angle?: string;
  /** Stored pixel size, when known. */
  width?: number;
  height?: number;
  /** Intake saw text, borders, watermarks or stickers added on top of the
   * photo (intake version 5). The product's own logo or label never counts. */
  addedOverlays?: boolean;
}

/**
 * What the planner needs from the options: booleans, enums, R2 keys and
 * pixel sizes only. It never reaches the LLM (the runner strips `output`
 * from the plan recipe input).
 */
export interface OutputPlanFlags {
  background: "remove" | "keep";
  keepMediaIds: string[];
  extras: OutputExtras;
  fit: "auto" | "pad";
  photos: PlanPhoto[];
}

/** The plan flags for resolved options and the pack's photos. No hex, no free text. */
export function planFlagsOf(
  resolved: Pick<ResolvedOutputOptions, "background" | "keepMediaIds" | "extras" | "fit">,
  photos: readonly PlanPhoto[],
): OutputPlanFlags {
  return {
    background: resolved.background,
    keepMediaIds: [...resolved.keepMediaIds],
    extras: { ...resolved.extras },
    fit: resolved.fit,
    photos: photos.map((photo) => ({
      id: photo.id,
      ...(photo.angle !== undefined ? { angle: photo.angle } : {}),
      ...(photo.width !== undefined ? { width: photo.width } : {}),
      ...(photo.height !== undefined ? { height: photo.height } : {}),
      ...(photo.addedOverlays === true ? { addedOverlays: true } : {}),
    })),
  };
}

/**
 * What a planned image looks like, for matching it to a spec's rules:
 * - white: the product on pure white (main image, alternate angles).
 * - transparent: the cutout PNG, which keeps its alpha.
 * - colored: a studio sweep in a color other than white.
 * - text: a template with copy on a colored card (infographic, dimensions,
 *   in the box, comparison).
 * - generated: a composited scene from an image model.
 * - original: the seller's kept photo, with its own background.
 */
export type PlannedImageKind = "white" | "transparent" | "colored" | "text" | "generated" | "original";

function isPureWhite(rgb: readonly number[] | undefined): boolean {
  return !!rgb && rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255;
}

/** True when the spec's background rule allows a backdrop other than white. */
function allowsColoredBackground(spec: ChannelSpec): boolean {
  const bg = spec.background?.type;
  return bg === undefined || bg === "any" || bg === "consistent";
}

/**
 * Whether an image of this kind meets the spec's registry rules. Solid white
 * and white preferred specs take only white images. Text needs textAllowed
 * and a background rule that allows the template's card color. The cutout
 * needs PNG and a background rule that keeps transparency; a spec that does
 * not would get the front photo flattened onto white again, a duplicate of
 * the white front image. A kept photo needs a spec that does not require
 * white and whose rule is absent, any or consistent.
 */
export function specAcceptsImage(spec: ChannelSpec, kind: PlannedImageKind): boolean {
  const bg = spec.background;
  switch (kind) {
    case "white":
      return bg?.type !== "solid" || isPureWhite(bg.rgb);
    case "transparent":
      return (
        (!spec.formats || spec.formats.includes("png")) &&
        (bg === undefined || bg.type === "any" || bg.type === "consistent" || bg.type === "white_or_transparent")
      );
    case "colored":
    case "generated":
      return allowsColoredBackground(spec);
    case "text":
      return spec.textAllowed !== false && allowsColoredBackground(spec);
    case "original":
      return !requiresWhiteBackground(spec) && allowsColoredBackground(spec);
  }
}

export interface GallerySlot {
  family: string;
  /** The spec the family's listing images ship on. */
  specId: string;
  /** Generated scenes (composite and edit methods) may ship here. The newer
   * marketplaces get deterministic and template images only. */
  generated: boolean;
  /** The listing's first image comes from this same spec, so the white front
   * image leads it. Amazon has its own amazon.main spec instead. */
  leadsWithWhiteFront: boolean;
}

/** Listing image slots per marketplace family, in plan order. */
export const GALLERY_SLOTS: readonly GallerySlot[] = [
  { family: "amazon", specId: "amazon.secondary", generated: true, leadsWithWhiteFront: false },
  { family: "shopify", specId: "shopify.product", generated: true, leadsWithWhiteFront: false },
  { family: "google", specId: "google.merchant.lifestyle", generated: true, leadsWithWhiteFront: false },
  { family: "etsy", specId: "etsy.listing", generated: false, leadsWithWhiteFront: true },
  { family: "ebay", specId: "ebay.listing", generated: false, leadsWithWhiteFront: true },
  { family: "walmart", specId: "walmart.main", generated: false, leadsWithWhiteFront: true },
  { family: "tiktokshop", specId: "tiktokshop.main", generated: false, leadsWithWhiteFront: true },
];

/** Gallery spec ids whose registry rule requires white (walmart.main and
 * tiktokshop.main today), read from the registry, never a literal list. */
export function whiteRequiredGallerySpecIds(): string[] {
  return GALLERY_SLOTS.map((slot) => slot.specId).filter((id) => hasSpec(id) && requiresWhiteBackground(getSpec(id)));
}

function knownSpecs(specIds: readonly string[]): ChannelSpec[] {
  return specIds.filter(hasSpec).map(getSpec);
}

/** The front photo: the one tagged front, else the first. */
export function frontPhotoOf(photos: readonly PlanPhoto[]): PlanPhoto | undefined {
  return photos.find((photo) => photo.angle === "front") ?? photos[0];
}

/** True for the photo the in_the_box graphic is made from. */
function isInTheBoxPhoto(photo: PlanPhoto): boolean {
  return photo.angle === "packaging" || photo.angle === "in_the_box";
}

/**
 * The photos that feed a cutout shot, in photo order. Every removed photo;
 * the front photo when any extra is on or any picked spec requires white;
 * the in the box photo when graphics are on; any other kept photo when a
 * picked white required gallery spec exists (its made white angles).
 */
export function cutoutMediaIds(photos: readonly PlanPhoto[], specIds: readonly string[], flags: OutputPlanFlags): string[] {
  const kept = new Set(flags.keepMediaIds);
  const specs = knownSpecs(specIds);
  const anyExtra = EXTRA_FAMILY_KEYS.some((family) => flags.extras[family]);
  const anyWhite = specs.some(requiresWhiteBackground);
  const whiteGallery = new Set(whiteRequiredGallerySpecIds());
  const anyWhiteGallery = specs.some((spec) => whiteGallery.has(spec.id));
  const front = frontPhotoOf(photos);
  const out: string[] = [];
  for (const photo of photos) {
    const needs =
      !kept.has(photo.id) ||
      (photo === front && (anyExtra || anyWhite)) ||
      (flags.extras.graphics && isInTheBoxPhoto(photo)) ||
      anyWhiteGallery;
    if (needs && !out.includes(photo.id)) {
      out.push(photo.id);
    }
  }
  return out;
}

/** True when the pack needs any cutout, so it cannot run while cutouts are paused. */
export function packNeedsCutout(specIds: readonly string[], flags: OutputPlanFlags): boolean {
  return cutoutMediaIds(flags.photos, specIds, flags).length > 0;
}

/** "#1F2A44" as [31, 42, 68]. */
export function hexToRgb(hex: string): [number, number, number] {
  if (!HEX.test(hex)) {
    throw new Error(`Not a hex color: ${hex}`);
  }
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [31, 42, 68] as "#1F2A44". */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export interface SpecBackground {
  rgb: [number, number, number];
  /** True when the spec requires white and the seller chose another color,
   * so this file uses white instead of the choice. */
  forcedWhite: boolean;
}

/**
 * The background for one output spec. A spec whose rule requires white gets
 * its registry white (or seed white), whatever the seller picked; every
 * other spec gets the resolved color. Absent options mean seed white.
 */
export function backgroundFor(spec: ChannelSpec, resolved?: Pick<ResolvedOutputOptions, "colorHex"> | null): SpecBackground {
  const chosen = hexToRgb(resolved?.colorHex ?? stillStyle.whiteHex);
  if (requiresWhiteBackground(spec)) {
    const white = spec.background?.rgb ?? hexToRgb(stillStyle.whiteHex);
    const rgb: [number, number, number] = [white[0], white[1], white[2]];
    return { rgb, forcedWhite: rgbToHex(chosen) !== rgbToHex(rgb) };
  }
  return { rgb: chosen, forcedWhite: false };
}

/**
 * How a kept photo is fitted to a spec. An exact size spec always gets added
 * space. A spec that refuses added borders (eBay, TikTok Shop) always keeps
 * the photo's shape, even with pad. Otherwise the seller's choice.
 */
export function originalFitFor(spec: ChannelSpec, resolved?: Pick<ResolvedOutputOptions, "fit"> | null): "auto" | "pad" {
  if (!allowsAddedBorders(spec)) {
    return "auto";
  }
  if (isExactSize(spec)) {
    return "pad";
  }
  return resolved?.fit ?? "auto";
}

/**
 * Canvas size for a spec: its fixed size, or the seeded default raised to
 * the spec minimum and capped at the spec maximum when the spec leaves it
 * open. Same rule as the worker's canvasSizeFor.
 */
export function canvasSizeFor(spec: ChannelSpec): { width: number; height: number } {
  const bounds = dimensionBounds(spec);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const width = spec.width ?? clamp(canvasDefaults.width, bounds.minWidth, bounds.maxWidth);
  const height = spec.height ?? clamp(width, bounds.minHeight, bounds.maxHeight);
  return { width, height };
}

/**
 * The shortest long side a kept output may have on this spec. It equals
 * qc/pixelChecks minLongSideFor for every spec that accepts a kept photo
 * (main class specs, which add a QC fallback, require white and never take
 * one); a test holds the two together.
 */
function minLongSideOf(spec: ChannelSpec): number {
  return Math.max(spec.minLongSide ?? 1, dimensionBounds(spec).minLongSide);
}

export interface OriginalScale {
  /** Resize factor for the photo; 1 means no resampling. */
  scale: number;
  /** Placed photo size in output pixels. */
  width: number;
  height: number;
  /** Set when the photo cannot reach the spec within the enlarge cap. */
  skip?: typeof SOURCE_TOO_SMALL_REASON;
}

/**
 * The scale for a kept photo on one spec (PHASE_15 control 6).
 * auto: s = min(maxW / w, maxH / h, maxLongSide / long, sqrt(maxMP / (w * h)), 1),
 * with maxMP the smaller of spec.maxMegapixels and seed
 * originalFit.maxMegapixels. When that misses the spec's minimum long side,
 * minWidth or minHeight, s rises to meet all three, but never above
 * MAX_SOURCE_UPSCALE nor past a maximum; otherwise the photo is skipped with
 * SOURCE_TOO_SMALL_REASON. pad: the photo fits inside the canvas (inside the
 * safe zone when the spec has one) and is never enlarged, since the canvas
 * meets the spec's size; pad never skips.
 */
export function originalScale(
  photo: { width: number; height: number },
  spec: ChannelSpec,
  resolved?: Pick<ResolvedOutputOptions, "fit"> | null,
): OriginalScale {
  const { width: w, height: h } = photo;
  const placed = (scale: number): OriginalScale => ({
    scale,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  });
  if (!(w > 0 && h > 0)) {
    return { scale: 0, width: 0, height: 0, skip: SOURCE_TOO_SMALL_REASON };
  }
  const maxMegapixels = Math.min(spec.maxMegapixels ?? Number.POSITIVE_INFINITY, originalFit.maxMegapixels);
  const byMegapixels = Math.sqrt((maxMegapixels * 1_000_000) / (w * h));
  if (originalFitFor(spec, resolved) === "pad") {
    const canvas = canvasSizeFor(spec);
    const safeHeight = canvas.height - (spec.safeZone?.top ?? 0) - (spec.safeZone?.bottom ?? 0);
    return placed(Math.min(canvas.width / w, Math.max(1, safeHeight) / h, byMegapixels, 1));
  }
  const bounds = dimensionBounds(spec);
  const long = Math.max(w, h);
  const upper = Math.min(bounds.maxWidth / w, bounds.maxHeight / h, bounds.maxLongSide / long, byMegapixels);
  const need = Math.max(minLongSideOf(spec) / long, bounds.minWidth / w, bounds.minHeight / h);
  const scale = Math.min(upper, 1);
  if (scale >= need) {
    return placed(scale);
  }
  if (need > MAX_SOURCE_UPSCALE || need > upper) {
    return { ...placed(Math.min(need, upper, MAX_SOURCE_UPSCALE)), skip: SOURCE_TOO_SMALL_REASON };
  }
  return placed(need);
}

/** Conflict codes; the copy lives in apps/web/src/lib/output-options-copy.ts (rule 9). */
export type OutputConflictCode =
  | "white_required"
  | "borders_refused"
  | "overlays_refused"
  | "mixed_consistent"
  | "other_items"
  | "too_small";

export interface OutputConflict {
  code: OutputConflictCode;
  /** The spec the conflict is about, when it is about one. */
  specId?: string;
  /** The photo the conflict is about, when it is about one. */
  photoId?: string;
}

/** A photo as conflictsFor sees it: the plan photo plus what the preflight found. */
export interface ConflictPhoto extends PlanPhoto {
  /** The preflight saw other items in the photo. */
  otherItems?: boolean;
}

/**
 * The specs a kept photo may ship on: the front photo takes every picked spec
 * that accepts a kept photo; every other kept photo takes the gallery specs
 * only. Same routing as the planner.
 */
export function keptPhotoSpecIds(photo: PlanPhoto, photos: readonly PlanPhoto[], specIds: readonly string[]): string[] {
  const gallery = new Set(GALLERY_SLOTS.map((slot) => slot.specId));
  const isFront = frontPhotoOf(photos)?.id === photo.id;
  return knownSpecs(specIds)
    .filter((spec) => specAcceptsImage(spec, "original") && (isFront || gallery.has(spec.id)))
    .map((spec) => spec.id);
}

/**
 * What the seller should know about these choices, as codes only:
 * - white_required: a picked white required spec ignores the choice (a kept
 *   photo, or a color other than white).
 * - borders_refused: pad was asked for on a spec that refuses added borders.
 * - overlays_refused: a kept photo ships on a spec that refuses added text
 *   and overlays.
 * - mixed_consistent: a consistent style spec gets a color other than white.
 * - other_items: a kept photo shows other items, which stay in the picture.
 * - too_small: a kept photo of known size cannot reach a spec.
 */
export function conflictsFor(
  specIds: readonly string[],
  resolved: Pick<ResolvedOutputOptions, "colorHex" | "fit" | "keepMediaIds">,
  photos: readonly ConflictPhoto[],
): OutputConflict[] {
  const out: OutputConflict[] = [];
  const specs = knownSpecs(specIds);
  const kept = photos.filter((photo) => resolved.keepMediaIds.includes(photo.id));
  const colorIsWhite = resolved.colorHex.toUpperCase() === stillStyle.whiteHex.toUpperCase();
  // Some photo gets the color: the pack removes backgrounds, or keeps only some.
  const someRemoved = kept.length === 0 || kept.length < photos.length;
  for (const spec of specs) {
    if (requiresWhiteBackground(spec) && (kept.length > 0 || !colorIsWhite)) {
      out.push({ code: "white_required", specId: spec.id });
    }
    if (spec.background?.type === "consistent" && !colorIsWhite && someRemoved) {
      out.push({ code: "mixed_consistent", specId: spec.id });
    }
  }
  const keptSpecs = new Set(kept.flatMap((photo) => keptPhotoSpecIds(photo, photos, specIds)));
  for (const spec of specs) {
    if (!keptSpecs.has(spec.id)) {
      continue;
    }
    if (resolved.fit === "pad" && !allowsAddedBorders(spec)) {
      out.push({ code: "borders_refused", specId: spec.id });
    }
    if (refusesOverlays(spec)) {
      out.push({ code: "overlays_refused", specId: spec.id });
    }
  }
  for (const photo of kept) {
    if (photo.otherItems) {
      out.push({ code: "other_items", photoId: photo.id });
    }
    if (photo.width === undefined || photo.height === undefined) {
      continue;
    }
    for (const specId of keptPhotoSpecIds(photo, photos, specIds)) {
      if (originalScale({ width: photo.width, height: photo.height }, getSpec(specId), resolved).skip) {
        out.push({ code: "too_small", specId, photoId: photo.id });
      }
    }
  }
  return out;
}
