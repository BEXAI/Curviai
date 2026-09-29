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
 * rule 2). Each P1 field (crop fit, edge match, scene count and style, logo,
 * product size, never enlarge, graphics color) joined the schema with its
 * renderer; a stored row from before P1 reads them as their defaults.
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
import {
  backgroundSwatches,
  canvasDefaults,
  originalFit,
  packBundles,
  presets,
  sceneCountOptions,
  stillStyle,
  type BackgroundSwatchKey,
  type PackBundle,
  type PackBundleKey,
  type PresetKey,
} from "./seed/templates";
import { variationOptions } from "./seed/variations";

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
  /** Match my photo's edges (P1): a kept photo's added space takes the
   * median color of its own outer ring. Removed photos and extras use white. */
  z.object({ kind: z.literal("edge_match") }).strict(),
]);
export type ColorChoice = z.infer<typeof ColorChoice>;

/** The switchable extra image families (PHASE_15 control 5). ads (PHASE_16
 * workstream 3: the moodboard pin, the carousel and the ad pack) is off
 * unless the seller turns it on, and is left out of the options while off
 * (compactExtras), so every pack from before it keeps its options key. */
export const EXTRA_FAMILY_KEYS = ["scenes", "backdrops", "transparentPng", "graphics", "cards", "ads"] as const;
export type ExtraFamily = (typeof EXTRA_FAMILY_KEYS)[number];

/** Shot types per extra family. A shot type in no family is never switchable. */
export const EXTRA_FAMILIES: Readonly<Record<ExtraFamily, readonly Shot["type"][]>> = {
  scenes: ["lifestyle", "shopify_hero"],
  backdrops: ["sweep_gray", "sweep_brand"],
  transparentPng: ["cutout_png"],
  graphics: ["infographic", "dimensions", "in_the_box", "comparison"],
  cards: ["social_1x1", "social_4x5", "social_9x16", "social_2x3", "aplus_banner"],
  ads: ["pin_moodboard", "carousel_slide", "ad_variant"],
};

/** Extra families that start off in every look and bundle, and are written
 * into the options only when on. */
const OFF_UNLESS_ON_FAMILIES: readonly ExtraFamily[] = ["ads"];

/**
 * The extras with every off unless on family (ads) left out while it is off,
 * so absent and false read the same and today's options keep their key. The
 * other families are always written.
 */
export function compactExtras(extras: OutputExtras): OutputExtras {
  const out = { ...extras };
  for (const family of OFF_UNLESS_ON_FAMILIES) {
    if (out[family] !== true) {
      delete out[family];
    }
  }
  return out;
}

/** True when the family is switched on. An absent ads switch is off. */
export function extraOn(extras: Partial<OutputExtras>, family: ExtraFamily): boolean {
  return extras[family] === true;
}

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

// ---------------------------------------------------------------------------
// Pack bundles (PHASE_16 workstream 1): how much a pack makes.

/** Reason recorded in skipped for a shot outside the seller's pack bundle.
 * The copy lives in apps/web/src/lib/job-copy.ts (rule 9). */
export const BUNDLE_OFF_REASON = "not in the chosen set";

/** Seeded bundle keys, in card order. */
export const BUNDLE_KEYS = Object.keys(packBundles) as [PackBundleKey, ...PackBundleKey[]];
export type BundleKey = PackBundleKey;

/** The bundle a pack uses unless the seller picks another: today's pack. */
export const DEFAULT_BUNDLE: BundleKey = "everything";

/** The pack's bundle; absent (every row before PHASE_16) is today's pack. */
export function bundleOf(options?: { bundle?: BundleKey } | null): BundleKey {
  return options?.bundle ?? DEFAULT_BUNDLE;
}

/** Every shot type the bundle may plan: its shotTypes and its A+ modules. */
export function bundleShotTypes(bundle: BundleKey): ReadonlySet<Shot["type"]> {
  const entry: PackBundle = packBundles[bundle];
  return new Set([...entry.shotTypes, ...(entry.aplusModules ?? [])]);
}

/** True when the bundle holds any shot type of this extra family, so its
 * Extra images switch can be on. */
export function bundleHoldsFamily(bundle: BundleKey, family: ExtraFamily): boolean {
  const types = bundleShotTypes(bundle);
  return EXTRA_FAMILIES[family].some((type) => types.has(type));
}

/** The Extra images switches a bundle starts from: its seeded extras with
 * Remove, every extra off with Keep. */
export function bundleExtrasFor(bundle: BundleKey, background: "remove" | "keep"): OutputExtras {
  const seeded = packBundles[bundle].extras;
  const out = {} as OutputExtras;
  for (const family of EXTRA_FAMILY_KEYS) {
    out[family] = background === "remove" && seeded[family] && bundleHoldsFamily(bundle, family);
  }
  return compactExtras(out);
}

/** The most other angle images the bundle plans, or null for no cap. */
export function bundleMaxSecondary(bundle: BundleKey): number | null {
  const entry: PackBundle = packBundles[bundle];
  return entry.maxSecondary ?? null;
}

/** Shot types that count against a bundle's maxSecondary when they are not
 * the front image (priority above 1): a white alternate angle, a kept photo. */
const SECONDARY_SHOT_TYPES: ReadonlySet<Shot["type"]> = new Set<Shot["type"]>(["alt_angle_white", "original_photo"]);

/** True for an other angle image: a white alternate angle or a kept photo
 * that does not lead a listing (the planner gives the front image priority 1). */
export function isSecondaryShot(shot: Pick<Shot, "type" | "priority">): boolean {
  return SECONDARY_SHOT_TYPES.has(shot.type) && shot.priority > 1;
}

export const LOOK_KEYS =["marketplace", "keep_photo", "brand"] as const;
export type LookKey = (typeof LOOK_KEYS)[number];
/** A look the server derives: a preset key, or custom when no preset matches. */
export type Look = LookKey | "custom";

const Background = z.enum(["remove", "keep"]);
/** auto keeps the photo's shape, pad adds flat space, crop (P1) trims to the
 * channel's shape around the product box. */
const Fit = z.enum(["auto", "pad", "crop"]);
export type OutputFit = z.infer<typeof Fit>;

/** Scene style (P1): auto lets the planner and the brand kit pick; a seeded
 * preset key overrides both for this pack. */
export const SCENE_PRESET_AUTO = "auto";
export const SCENE_PRESET_KEYS = [SCENE_PRESET_AUTO, ...(Object.keys(presets) as PresetKey[])] as [
  typeof SCENE_PRESET_AUTO,
  ...PresetKey[],
];
const ScenePreset = z.enum(SCENE_PRESET_KEYS);
export type ScenePresetChoice = z.infer<typeof ScenePreset>;

/** Product size in the frame (P1), keys of seed canvasDefaults.productSizeFill. */
export const PRODUCT_SIZE_KEYS = Object.keys(canvasDefaults.productSizeFill) as [
  keyof typeof canvasDefaults.productSizeFill,
  ...(keyof typeof canvasDefaults.productSizeFill)[],
];
const ProductSize = z.enum(PRODUCT_SIZE_KEYS);
export type ProductSize = z.infer<typeof ProductSize>;

const SceneCount = z.number().int().min(sceneCountOptions.min).max(sceneCountOptions.max);

// Scene variations (PHASE_16 workstream 6): versions made of each lifestyle
// scene, the seller picks which ones ship.

/** Versions of each lifestyle scene a pack makes unless the seller asks for more. */
export const DEFAULT_VARIATIONS: number = variationOptions.default;

const Variations = z.number().int().min(variationOptions.min).max(variationOptions.max);

/** Versions of each lifestyle scene the pack makes; absent (every row before
 * PHASE_16) is the seed default. */
export function variationsOf(options?: { variations?: number } | null): number {
  return options?.variations ?? DEFAULT_VARIATIONS;
}

/** The P1 choices' defaults: today's pack, with the seeded scene count. */
export const P1_DEFAULTS: OutputP1Choices = {
  sceneCount: sceneCountOptions.default,
  scenePreset: SCENE_PRESET_AUTO,
  logo: true,
  productSize: "standard",
  enlarge: true,
  graphicsColor: false,
};

/** The P1 choices, filled. */
export interface OutputP1Choices {
  sceneCount: number;
  scenePreset: ScenePresetChoice;
  logo: boolean;
  productSize: ProductSize;
  enlarge: boolean;
  graphicsColor: boolean;
}

const ExtrasInput = z
  .object({
    scenes: z.boolean(),
    backdrops: z.boolean(),
    transparentPng: z.boolean(),
    graphics: z.boolean(),
    cards: z.boolean(),
    ads: z.boolean(),
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
    /** The ads family (PHASE_16); absent is off. */
    ads: z.boolean().optional(),
  })
  .strict();
export type OutputExtras = z.infer<typeof Extras>;

/** A seeded pack bundle key. */
const Bundle = z.enum(BUNDLE_KEYS);

/**
 * What a request may send, strict: an unknown key or an out of range value
 * is refused.
 */
export const OutputOptionsInput = z
  .object({
    v: z.literal(1).default(1),
    lookBase: z.enum(LOOK_KEYS).optional(),
    background: Background.default("remove"),
    color: ColorChoice.default({ kind: "swatch", key: DEFAULT_SWATCH_KEY }),
    fit: Fit.default("auto"),
    extras: ExtrasInput.default({}),
    sceneCount: SceneCount.default(P1_DEFAULTS.sceneCount),
    scenePreset: ScenePreset.default(P1_DEFAULTS.scenePreset),
    logo: z.boolean().default(P1_DEFAULTS.logo),
    productSize: ProductSize.default(P1_DEFAULTS.productSize),
    enlarge: z.boolean().default(P1_DEFAULTS.enlarge),
    graphicsColor: z.boolean().default(P1_DEFAULTS.graphicsColor),
    /** How much the pack makes (PHASE_16 workstream 1); today's pack by default. */
    bundle: Bundle.default(DEFAULT_BUNDLE),
    /** Versions of each lifestyle scene (PHASE_16 workstream 6); one by default. */
    variations: Variations.default(DEFAULT_VARIATIONS),
  })
  .strict();
/** The request shape, before defaults. */
export type OutputOptionsInput = z.input<typeof OutputOptionsInput>;

/** Options after normalization: every field filled, extras complete. */
export interface NormalizedOutputOptions extends OutputP1Choices {
  v: 1;
  lookBase?: LookKey;
  background: "remove" | "keep";
  color: ColorChoice;
  fit: OutputFit;
  extras: OutputExtras;
  /** The pack bundle (PHASE_16); absent is today's pack (DEFAULT_BUNDLE), so
   * a pack that keeps the default reads exactly as before. Read it with bundleOf. */
  bundle?: BundleKey;
  /** Versions of each lifestyle scene (PHASE_16); absent is the seed default,
   * so a pack that keeps it reads exactly as before. Read it with variationsOf. */
  variations?: number;
}

/** The choices a look fixes: normalized options without lookBase. The
 * bundle rides along; a look never sets it (lookOf reads it). */
export type OutputChoices = Omit<NormalizedOutputOptions, "lookBase">;

function allExtras(on: boolean): OutputExtras {
  return { scenes: on, backdrops: on, transparentPng: on, graphics: on, cards: on };
}

/**
 * Parses and fills a request's options. Missing extras follow the
 * background and the bundle: the bundle's seeded extras with remove (all on
 * for today's pack), all off with keep. A family the bundle holds no shot
 * type of is always off. An absent options object normalizes to today's
 * pack exactly, and bundle is left out when it is the default. Throws a
 * ZodError on anything the P0 schema refuses.
 */
export function normalizeOutputOptions(input?: OutputOptionsInput | null): NormalizedOutputOptions {
  const parsed = OutputOptionsInput.parse(input ?? {});
  const bundle = parsed.bundle;
  const merged: OutputExtras = { ...bundleExtrasFor(bundle, parsed.background), ...parsed.extras };
  for (const family of EXTRA_FAMILY_KEYS) {
    if (merged[family] !== undefined) {
      merged[family] &&= bundleHoldsFamily(bundle, family);
    }
  }
  const extras = compactExtras(merged);
  return {
    v: 1,
    ...(parsed.lookBase !== undefined ? { lookBase: parsed.lookBase } : {}),
    background: parsed.background,
    color: parsed.color,
    fit: parsed.fit,
    extras,
    sceneCount: parsed.sceneCount,
    scenePreset: parsed.scenePreset,
    logo: parsed.logo,
    productSize: parsed.productSize,
    enlarge: parsed.enlarge,
    graphicsColor: parsed.graphicsColor,
    ...(bundle !== DEFAULT_BUNDLE ? { bundle } : {}),
    ...(parsed.variations !== DEFAULT_VARIATIONS ? { variations: parsed.variations } : {}),
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
    ...P1_DEFAULTS,
  },
  keep_photo: {
    v: 1,
    background: "keep",
    color: { kind: "swatch", key: DEFAULT_SWATCH_KEY },
    fit: "auto",
    extras: allExtras(false),
    ...P1_DEFAULTS,
  },
  brand: {
    v: 1,
    background: "remove",
    color: { kind: "brand", index: 0 },
    fit: "auto",
    extras: allExtras(true),
    ...P1_DEFAULTS,
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
  return {
    v: 1,
    background: options.background,
    color: options.color,
    fit: options.fit,
    extras: compactExtras(options.extras),
    sceneCount: options.sceneCount,
    scenePreset: options.scenePreset,
    logo: options.logo,
    productSize: options.productSize,
    enlarge: options.enlarge,
    graphicsColor: options.graphicsColor,
    ...(bundleOf(options) !== DEFAULT_BUNDLE ? { bundle: bundleOf(options) } : {}),
    ...(variationsOf(options) !== DEFAULT_VARIATIONS ? { variations: variationsOf(options) } : {}),
  };
}

/**
 * A look's preset for a bundle: the look's choices with the Extra images
 * switches the bundle starts from (bundleExtrasFor). With today's pack it is
 * LOOK_PRESETS[look] exactly. The form's look cards, Reset and the Custom
 * chip start from this, so picking a bundle never reads as Custom.
 */
export function lookPresetFor(look: LookKey, bundle: BundleKey = DEFAULT_BUNDLE): OutputChoices {
  const preset = LOOK_PRESETS[look];
  return {
    ...preset,
    color: { ...preset.color },
    extras: bundle === DEFAULT_BUNDLE ? { ...preset.extras } : bundleExtrasFor(bundle, preset.background),
    ...(bundle !== DEFAULT_BUNDLE ? { bundle } : {}),
  };
}

/** The look the choices amount to: the preset key on an exact match with
 * that look's preset for the same bundle, otherwise custom. */
export function lookOf(options: NormalizedOutputOptions | OutputChoices): Look {
  // Variations ride along like the bundle: a look never sets them.
  const key = canonicalJson({ ...choicesOf(options), variations: undefined });
  const bundle = bundleOf(options);
  for (const look of LOOK_KEYS) {
    if (canonicalJson(choicesOf(lookPresetFor(look, bundle))) === key) {
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
 * this schema and fails the job closed on anything else. The P1 fields are
 * optional so a row stored before P1 still parses; read them through the
 * accessors below (sceneCountOf, keptMaxUpscale and the rest), which fill
 * the defaults.
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
    sceneCount: SceneCount.optional(),
    scenePreset: ScenePreset.optional(),
    logo: z.boolean().optional(),
    productSize: ProductSize.optional(),
    enlarge: z.boolean().optional(),
    graphicsColor: z.boolean().optional(),
    /** The pack bundle (PHASE_16); absent is today's pack. Read with bundleOf. */
    bundle: Bundle.optional(),
    /** Versions of each lifestyle scene (PHASE_16); absent is one. Read with variationsOf. */
    variations: Variations.optional(),
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
 * plan includes brand kits is createJob's check, not this one. Edge match
 * resolves to seed white: removed photos and extras use it, and each kept
 * photo's added space takes its own edge color at render time.
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
    case "edge_match":
      return stillStyle.whiteHex.toUpperCase();
  }
}

/** The P1 fields as a job carries them; absent on rows stored before P1. */
type P1Fields = Partial<OutputP1Choices>;

/** Lifestyle scenes the pack plans (P1 "Number of scenes"); the seeded
 * default without options. Scenes off is extras.scenes, not a count. */
export function sceneCountOf(options?: Pick<P1Fields, "sceneCount"> | null): number {
  return options?.sceneCount ?? P1_DEFAULTS.sceneCount;
}

/** The seller's scene style, or null for auto (the planner and brand kit pick). */
export function scenePresetOf(options?: Pick<P1Fields, "scenePreset"> | null): PresetKey | null {
  const preset = options?.scenePreset ?? P1_DEFAULTS.scenePreset;
  return preset === SCENE_PRESET_AUTO ? null : preset;
}

/** Whether template graphics carry the brand logo (P1 "Logo on graphics"). */
export function logoOn(options?: Pick<P1Fields, "logo"> | null): boolean {
  return options?.logo ?? P1_DEFAULTS.logo;
}

/** Whether template cards use the chosen color (P1 "Graphics follow your color"). */
export function graphicsFollowColor(options?: Pick<P1Fields, "graphicsColor"> | null): boolean {
  return options?.graphicsColor ?? P1_DEFAULTS.graphicsColor;
}

/** The most a kept photo is enlarged: MAX_SOURCE_UPSCALE, or 1 with Never
 * enlarge my photo (P1). */
export function keptMaxUpscale(options?: Pick<P1Fields, "enlarge"> | null): number {
  return (options?.enlarge ?? P1_DEFAULTS.enlarge) ? MAX_SOURCE_UPSCALE : 1;
}

/**
 * The product fill for a removed photo on this spec (P1 "Product size in the
 * frame"): the seeded share for the seller's size, clamped into spec.fill
 * when the spec sets one, so amazon.main stays within its registry range.
 * The renderers also keep the product inside canvasDefaults.maxAxisShare.
 */
export function productSizeFillFor(spec: ChannelSpec, options?: Pick<P1Fields, "productSize"> | null): number {
  const fill = canvasDefaults.productSizeFill[options?.productSize ?? P1_DEFAULTS.productSize];
  return spec.fill ? Math.min(spec.fill.max, Math.max(spec.fill.min, fill)) : fill;
}

/** A photo's own background choice (P1 "Background per photo"); pack
 * follows the pack's switch. */
export type PhotoBackgroundChoice = "pack" | "remove" | "keep";

/**
 * The photos with Keep: a photo whose own choice is keep, and every photo
 * that follows the pack (no choice, or pack) when the pack keeps its
 * backgrounds. Photo order is kept.
 */
export function keepMediaIdsFor(
  options: Pick<NormalizedOutputOptions, "background">,
  photoIds: readonly string[],
  perPhoto?: Readonly<Partial<Record<string, PhotoBackgroundChoice>>>,
): string[] {
  return photoIds.filter((id) => {
    const own = perPhoto?.[id];
    return own === "keep" || ((own === undefined || own === "pack") && options.background === "keep");
  });
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
  fit: OutputFit;
  photos: PlanPhoto[];
  /** Lifestyle scenes to plan (P1); the seeded default when absent. */
  sceneCount?: number;
  /** False with Never enlarge my photo (P1): kept photos cap at 1. */
  enlarge?: boolean;
  /** The pack bundle (PHASE_16): shot types outside it, and other angle
   * images past its maxSecondary, are skipped with BUNDLE_OFF_REASON. Absent
   * is today's pack. */
  bundle?: BundleKey;
  /** Versions of each lifestyle scene (PHASE_16 workstream 6); absent is one. */
  variations?: number;
}

/** The plan flags for resolved options and the pack's photos. No hex, no free text. */
export function planFlagsOf(
  resolved: Pick<ResolvedOutputOptions, "background" | "keepMediaIds" | "extras" | "fit"> &
    Pick<P1Fields, "sceneCount" | "enlarge"> & { bundle?: BundleKey; variations?: number },
  photos: readonly PlanPhoto[],
): OutputPlanFlags {
  const bundle = bundleOf(resolved);
  return {
    background: resolved.background,
    keepMediaIds: [...resolved.keepMediaIds],
    extras: compactExtras(resolved.extras),
    fit: resolved.fit,
    sceneCount: sceneCountOf(resolved),
    enlarge: resolved.enlarge ?? P1_DEFAULTS.enlarge,
    ...(bundle !== DEFAULT_BUNDLE ? { bundle } : {}),
    ...(variationsOf(resolved) !== DEFAULT_VARIATIONS ? { variations: variationsOf(resolved) } : {}),
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

/** WCAG relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const linear = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * The card and text colors of a template graphic (infographic, dimensions,
 * in the box, comparison, social cards, banners). Today's look: the style
 * preset's seeded card color. With "Graphics follow your color" (P1) the
 * card takes the spec's resolved background (backgroundFor, so a white
 * required spec stays white), and the text flips to seed
 * stillStyle.textOnDarkHex on a card darker than darkBackgroundLuminance.
 */
export function templateCardColors(
  spec: ChannelSpec,
  stylePreset: string,
  resolved?: (Pick<ResolvedOutputOptions, "colorHex"> & { graphicsColor?: boolean }) | null,
): { backgroundHex: string; textHex: string } {
  const preset = (stillStyle.presetBackgroundHex as Record<string, string>)[stylePreset];
  const backgroundHex = graphicsFollowColor(resolved)
    ? rgbToHex(backgroundFor(spec, resolved).rgb)
    : (preset ?? stillStyle.defaultBackgroundHex);
  const dark = relativeLuminance(backgroundHex) < stillStyle.darkBackgroundLuminance;
  return { backgroundHex, textHex: dark ? stillStyle.textOnDarkHex : stillStyle.textHex };
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
 * How a kept photo is fitted to a spec. Crop (P1) trims to the spec's shape
 * on every spec, since it adds nothing; when the product box cannot fit, the
 * renderer falls back to cropFallbackFor. Otherwise an exact size spec always
 * gets added space, a spec that refuses added borders (eBay, TikTok Shop)
 * always keeps the photo's shape, even with pad, and every other spec takes
 * the seller's choice.
 */
export function originalFitFor(spec: ChannelSpec, resolved?: Pick<ResolvedOutputOptions, "fit"> | null): OutputFit {
  if (resolved?.fit === "crop") {
    return "crop";
  }
  if (!allowsAddedBorders(spec)) {
    return "auto";
  }
  if (isExactSize(spec)) {
    return "pad";
  }
  return resolved?.fit ?? "auto";
}

/** The fit a crop falls back to when the product box is unknown or does not
 * fit the spec's shape: pad, or auto on a spec that refuses added borders. */
export function cropFallbackFor(spec: ChannelSpec): "auto" | "pad" {
  return originalFitFor(spec, { fit: "pad" }) as "auto" | "pad";
}

/** A rectangle in upright source pixels. */
export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The crop window for a kept photo on one spec (P1 "Trim to the channel's
 * shape"), in upright source pixels: the largest window of the spec's canvas
 * aspect (canvasSizeFor) that fits in the photo and holds the product box
 * plus seed originalFit.cropMarginShare of the box's longest side on every
 * side (the margin stops at the photo's edge). On a spec with a safe zone
 * (meta.story_9x16, TikTok's left and right too) the box plus margin must also sit inside the zone once
 * the window is scaled to the canvas. The window is centered on the box as
 * far as those rules allow. null when there is no usable box or the box
 * cannot fit, and the caller falls back (cropFallbackFor). Pure.
 */
export function cropWindowFor(
  photo: { width: number; height: number },
  box: PixelBox | null | undefined,
  spec: ChannelSpec,
): PixelBox | null {
  const { width: W, height: H } = photo;
  if (!box || !(W > 0 && H > 0) || !(box.width > 0 && box.height > 0)) {
    return null;
  }
  const boxLeft = Math.max(0, box.left);
  const boxTop = Math.max(0, box.top);
  const boxRight = Math.min(W, box.left + box.width);
  const boxBottom = Math.min(H, box.top + box.height);
  if (!(boxRight > boxLeft && boxBottom > boxTop)) {
    return null;
  }
  const margin = originalFit.cropMarginShare * Math.max(boxRight - boxLeft, boxBottom - boxTop);
  const need = {
    left: Math.max(0, Math.floor(boxLeft - margin)),
    top: Math.max(0, Math.floor(boxTop - margin)),
    right: Math.min(W, Math.ceil(boxRight + margin)),
    bottom: Math.min(H, Math.ceil(boxBottom + margin)),
  };
  const canvas = canvasSizeFor(spec);
  const aspect = canvas.width / canvas.height;
  // The largest window of the canvas aspect inside the photo, in whole pixels.
  let winW = Math.min(W, Math.floor(H * aspect));
  let winH = Math.min(H, Math.round(winW / aspect));
  if (winH < 1 || winW < 1) {
    return null;
  }
  if (Math.abs(winW / winH - aspect) > 0.01) {
    winH = Math.min(H, Math.floor(winW / aspect));
    winW = Math.min(W, Math.round(winH * aspect));
  }
  // The safe zone, in window pixels.
  const zoneTop = Math.ceil(((spec.safeZone?.top ?? 0) * winH) / canvas.height);
  const zoneBottom = Math.ceil(((spec.safeZone?.bottom ?? 0) * winH) / canvas.height);
  const zoneLeft = Math.ceil(((spec.safeZone?.left ?? 0) * winW) / canvas.width);
  const zoneRight = Math.ceil(((spec.safeZone?.right ?? 0) * winW) / canvas.width);
  const place = (lo: number, hi: number, center: number): number | null => {
    if (lo > hi) return null;
    return Math.min(hi, Math.max(lo, Math.round(center)));
  };
  const left = place(
    Math.max(0, need.right - (winW - zoneRight)),
    Math.min(W - winW, need.left - zoneLeft),
    (need.left + need.right - winW - zoneLeft + zoneRight) / 2,
  );
  const top = place(
    Math.max(0, need.bottom - (winH - zoneBottom)),
    Math.min(H - winH, need.top - zoneTop),
    (need.top + need.bottom - winH - zoneTop + zoneBottom) / 2,
  );
  if (left === null || top === null) {
    return null;
  }
  return { left, top, width: winW, height: winH };
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
 * minWidth or minHeight, s rises to meet all three, but never above the
 * enlarge cap (keptMaxUpscale: MAX_SOURCE_UPSCALE, or 1 with Never enlarge)
 * nor past a maximum; otherwise the photo is skipped with
 * SOURCE_TOO_SMALL_REASON. pad: the photo fits inside the canvas (inside the
 * safe zone when the spec has one) and is never enlarged, since the canvas
 * meets the spec's size; pad never skips. crop is planned as its fallback,
 * since the box is only known at render time: pad never skips, and on a
 * spec that refuses added borders crop falls back to auto.
 */
export function originalScale(
  photo: { width: number; height: number },
  spec: ChannelSpec,
  resolved?: (Pick<ResolvedOutputOptions, "fit"> & { enlarge?: boolean }) | null,
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
  const fit = originalFitFor(spec, resolved);
  if ((fit === "crop" ? cropFallbackFor(spec) : fit) === "pad") {
    const canvas = canvasSizeFor(spec);
    const safeHeight = canvas.height - (spec.safeZone?.top ?? 0) - (spec.safeZone?.bottom ?? 0);
    const safeWidth = canvas.width - (spec.safeZone?.left ?? 0) - (spec.safeZone?.right ?? 0);
    return placed(Math.min(Math.max(1, safeWidth) / w, Math.max(1, safeHeight) / h, byMegapixels, 1));
  }
  const bounds = dimensionBounds(spec);
  const long = Math.max(w, h);
  const upper = Math.min(bounds.maxWidth / w, bounds.maxHeight / h, bounds.maxLongSide / long, byMegapixels);
  const need = Math.max(minLongSideOf(spec) / long, bounds.minWidth / w, bounds.minHeight / h);
  const scale = Math.min(upper, 1);
  if (scale >= need) {
    return placed(scale);
  }
  const cap = keptMaxUpscale(resolved);
  if (need > cap || need > upper) {
    return { ...placed(Math.min(need, upper, cap)), skip: SOURCE_TOO_SMALL_REASON };
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
  resolved: Pick<ResolvedOutputOptions, "colorHex" | "fit" | "keepMediaIds"> & { enlarge?: boolean },
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
