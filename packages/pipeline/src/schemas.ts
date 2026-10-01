/**
 * Source of truth Zod schemas for the pipeline (CURVI_BUILD_PLAN.md section 5.2,
 * verbatim). JSON Schema for tool or response formats is generated with
 * z.toJSONSchema via jsonSchemaFor below.
 */
import { z } from "zod";
// The pure schema module, not the package root: this file reaches client
// bundles, which must not pull in the provider adapters.
import { openaiSchemaLimitProblems, openaiStrictJsonSchema } from "@curvi/ai/openai-schema";
import { variationOptions } from "./seed/variations";

export const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const ProductProfile = z.object({
  productCount: z.number().int().min(1),
  category: z.enum(["apparel","footwear","jewelry","beauty","food_beverage","supplements","electronics","home_kitchen","furniture","toys","pet","sports_outdoor","other"]),
  amazonProductTypeGuess: z.string(), shopifyTaxonomyGuess: z.string(),
  name: z.string().max(120), formFactor: z.string(), materials: z.array(z.string()).max(8),
  dominantColors: z.array(z.object({ name: z.string(), hex: Hex, coveragePct: z.number() })).max(6),
  dimensions: z.object({ value: z.string(), source: z.enum(["user","packaging","unknown"]) }).nullable(),
  preserveText: z.array(z.object({ text: z.string(), location: z.string() })),
  preserveLogos: z.array(z.string()),
  surface: z.object({ reflective: z.boolean(), transparent: z.boolean(), textured: z.boolean() }),
  features: z.array(z.string()).max(8), benefits: z.array(z.string()).max(8),
  targetBuyer: z.string(), useContexts: z.array(z.string()).max(6),
  photographedAngles: z.array(z.enum(["front","45","side","back","top","bottom","detail","in_use","packaging"])),
  missingAnglesNeeded: z.array(z.string()),
  complianceFlags: z.array(z.enum(["possible_counterfeit","prohibited","adult","weapon","medical_claim","child_product","food_claim","none"])),
  imageQuality: z.object({ usableForMain: z.boolean(), issues: z.array(z.string()) })
});

export const Shot = z.object({
  id: z.string(), type: z.enum(["amazon_main","alt_angle_white","cutout_png","sweep_gray","sweep_brand","lifestyle","infographic","dimensions","in_the_box","comparison","aplus_banner","shopify_hero","collection_thumb","social_1x1","social_4x5","social_9x16","social_2x3","video_spin","video_hero_6s","video_lifestyle_15s","video_ugc_hook","original_photo","aplus_pain_points","aplus_features","aplus_ingredients","aplus_results","aplus_how_to","aplus_endorsement","pin_moodboard","carousel_slide","ad_variant"]),
  sourceMediaId: z.string(), method: z.enum(["deterministic","composite_generate","edit_generate","template","video_generate","avatar"]),
  channels: z.array(z.string()), stylePreset: z.string(), scene: z.string().max(400).optional(),
  callouts: z.array(z.string().max(40)).max(5).optional(), credits: z.number(), priority: z.number().int(),
  /** A+ module headline (PHASE_16 workstream 2), written by the copy step
   * after planning; the module's lines ride in callouts. Never asked of the
   * shot planner: LlmShot leaves it out. */
  headline: z.string().max(40).optional(),
  /** Ads formats (PHASE_16 workstream 3). A carousel's slides share one
   * carouselId; slideIndex counts from 1 and slideCount is the carousel's
   * length, so every slide knows the whole canvas it is cut from. */
  carouselId: z.string().max(40).optional(),
  slideIndex: z.number().int().min(1).max(10).optional(),
  slideCount: z.number().int().min(1).max(10).optional(),
  /** An ad variant's key within its pack ("v1" to "v6"). */
  variantKey: z.string().max(12).optional(),
  /** The call to action an ad variant or a carousel's last slide prints. */
  cta: z.string().max(40).optional(),
  /** Versions of this lifestyle scene the pack makes (PHASE_16 workstream
   * 6), set by applyVariations when the seller asks for more than one; its
   * credits already hold the extra ones. Absent is one. Never asked of the
   * shot planner: LlmShot leaves it out. */
  variations: z.number().int().min(variationOptions.min + 1).max(variationOptions.max).optional(),
  /** Which extra version of its scene this shot is (2 to 4), set only on the
   * shots expandVariations adds at run time. Absent is the scene itself. */
  variation: z.number().int().min(variationOptions.min + 1).max(variationOptions.max).optional(),
});

export const ShotList = z.object({ shots: z.array(Shot).max(40), skipped: z.array(z.object({ type: z.string(), reason: z.string() })) });

/**
 * Shot types only the deterministic planner may plan (PHASE_15). The LLM
 * never sees them: the plan recipe's tool schema is built from LlmShotList.
 */
export const DETERMINISTIC_ONLY_SHOT_TYPES = ["original_photo"] as const;

/**
 * The A+ module shot types (PHASE_16 workstream 2): template cards around
 * the real product. The deterministic planner plans them and the runner adds
 * them to an LLM plan; the shot planner recipe never sees them, until pnpm
 * eval shows it uses them well.
 */
export const APLUS_MODULE_SHOT_TYPES = [
  "aplus_pain_points",
  "aplus_features",
  "aplus_ingredients",
  "aplus_results",
  "aplus_how_to",
  "aplus_endorsement",
] as const;
export type AplusModuleShotType = (typeof APLUS_MODULE_SHOT_TYPES)[number];

/** True for an A+ module shot type. */
export function isAplusModuleType(type: string): type is AplusModuleShotType {
  return (APLUS_MODULE_SHOT_TYPES as readonly string[]).includes(type);
}

/**
 * The ads formats (PHASE_16 workstream 3): a moodboard pin, carousel slides
 * cut from one canvas and static ad variants. The deterministic planner
 * plans them from the seed; the shot planner recipe never sees them.
 */
export const ADS_SHOT_TYPES = ["pin_moodboard", "carousel_slide", "ad_variant"] as const;
export type AdsShotType = (typeof ADS_SHOT_TYPES)[number];

/** True for an ads format shot type. */
export function isAdsShotType(type: string): type is AdsShotType {
  return (ADS_SHOT_TYPES as readonly string[]).includes(type);
}

/** Shot types the shot planner recipe never plans. */
const NOT_LLM_SHOT_TYPES = [...DETERMINISTIC_ONLY_SHOT_TYPES, ...APLUS_MODULE_SHOT_TYPES, ...ADS_SHOT_TYPES] as const;

/** Shot without the deterministic only types, the A+ modules and the module
 * headline. The plan recipe's strict tool schema and validateLlmShotList use
 * it, so the LLM tool schema is the one the plan recipe has always had. */
export const LlmShot = Shot.extend({ type: Shot.shape.type.exclude(NOT_LLM_SHOT_TYPES) }).omit({
  headline: true,
  carouselId: true,
  slideIndex: true,
  slideCount: true,
  variantKey: true,
  cta: true,
  variations: true,
  variation: true,
});

export const LlmShotList = z.object({ shots: z.array(LlmShot).max(40), skipped: z.array(z.object({ type: z.string(), reason: z.string() })) });

export const QCVerdict = z.object({
  pass: z.boolean(), fidelity: z.number().min(0).max(1), issues: z.array(z.enum(["label_changed","logo_changed","shape_changed","color_shift","extra_items","artifact","bad_shadow","text_in_main","unrealistic_scale","other"])),
  repairHint: z.string().max(300)
});

/**
 * The seller's note as structured intent (docs/phases/PHASE_13.md), parsed
 * once by intake and passed to later stages as data, never as free text. It
 * decides which visible product is featured and what is left out; it can
 * never change rules, moderation, pricing or channel specs.
 */
export const SellerIntent = z.object({
  /** The one product the seller wants featured, in plain words, or null. */
  featureOnly: z.string().max(120).nullable(),
  /** Visible things the seller wants left out of every image. */
  exclude: z.array(z.string().max(120)).max(8),
  /** Visible text or parts the seller insists stay in the picture. */
  mustKeep: z.array(z.string().max(120)).max(8),
  /** Everything else in the note that is about style. */
  styleNotes: z.string().max(400).nullable(),
});

/**
 * A product box normalized to the image: x and y are the top left corner,
 * width and height the size, each a share (0..1) of the width or height of
 * the upright image intake was shown. Normalized coordinates survive the
 * resizing between the photo intake sees and the working copy the cutout
 * gets; every consumer converts with the size of the image it holds.
 */
export const NormalizedBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});

/** One product intake saw in an image, and whether it is the one the
 * seller's note asks for. */
export const IntakeProduct = z.object({
  label: z.string().max(120),
  box: NormalizedBox,
  matchesIntent: z.enum(["yes", "no", "unclear"]),
});

/** Result shape of the intake normalizer recipe: one entry per uploaded image. */
export const IntakeImageResult = z.object({
  sellableProduct: z.boolean(),
  distinctProducts: z.number().int().min(0),
  boundingBoxes: z
    .array(
      z.object({
        label: z.string(),
        x: z.number().min(0),
        y: z.number().min(0),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    )
    .optional(),
  sharpEnough: z.boolean(),
  /** True when the image is a screenshot or screen capture (an app, web
   * page, chat or phone screen, including a photo of a screen) rather than
   * a camera photo of the product. Optional so answers from intake recipe
   * version 1, which never asked, still parse. */
  screenshot: z.boolean().optional(),
  /** Every distinct product visible, with its box and whether it matches
   * the seller's note (intake version 3). Optional so answers from versions
   * 1 and 2, which never returned it, still parse and behave as before. */
  products: z.array(IntakeProduct).max(12).optional(),
  /** True when text, a border, a watermark or a sticker was added on top of
   * the photo (intake version 5, PHASE_15 P1). The product's own printed
   * logo or label is never an overlay. Defaults to false, so answers from
   * versions 1 to 4, which never asked, read as a clean photo. */
  addedOverlays: z.boolean().default(false),
  flags: z.object({
    nudity: z.boolean(),
    weapons: z.boolean(),
    drugs: z.boolean(),
    prohibited: z.boolean(),
    realPersonMainSubject: z.boolean(),
  }),
});

export const IntakeResult = z.object({
  images: z.array(IntakeImageResult).min(1),
  /** The seller's note parsed into intent (intake version 3). Optional so
   * version 1 and 2 answers still parse. */
  sellerIntent: SellerIntent.optional(),
});

/**
 * The intake answer shape sent to the model as its strict tool schema. The
 * version 3 fields, and version 5's addedOverlays, are required here: under strict tool use the model may
 * leave an optional property out, and on 2026-09-29 it did, so a pack with
 * two bottles and a note naming one ran with no product boxes and no parsed
 * intent. Answers are still validated with the lenient IntakeResult, so a
 * version 1 or 2 answer (or a mock) keeps parsing.
 */
export const IntakeToolResult = z.object({
  images: z
    .array(
      IntakeImageResult.extend({
        screenshot: z.boolean(),
        products: z.array(IntakeProduct).max(12),
        addedOverlays: z.boolean(),
      }),
    )
    .min(1),
  sellerIntent: SellerIntent,
});

/**
 * The target_picker answer (docs/phases/PHASE_13.md, inventory tie
 * breaker): the number of the one item on the contact sheet the seller's
 * note means, or null when none or several fit, with a confidence and a
 * short reason. Sent as the strict tool schema, so every field is required.
 */
export const TargetPick = z.object({
  choice: z.number().int().min(1).max(6).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().max(200),
});

/** TargetPick as answers are validated: a reason past 200 characters is cut,
 * not a reason to drop the answer. */
export const TargetPickAnswer = TargetPick.extend({
  reason: z.string().transform((text) => text.slice(0, 200)),
});

/*
 * Lenient answer schemas. strictToolSchema drops maxItems, maxLength,
 * minimum, maximum and pattern before a schema goes to the API, so a model
 * answer can go past a bound the prompt never stated (14 lipsticks on a flat
 * lay, 9 features on an electronics product). Failing the whole pack for that
 * is worse than keeping the first items, so these answers are normalized to
 * the bounds before the full schema checks them: arrays are cut to their
 * maximum, strings sliced to their length, numbers clamped to their range,
 * hex colors repaired or dropped. Anything else still fails validation.
 * The input is never mutated; the runner keeps the raw answer for its logs.
 */

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cutString(value: unknown, max: number): unknown {
  return typeof value === "string" ? value.slice(0, max) : value;
}

function cutArray(value: unknown, max: number, each?: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.slice(0, max);
  return each ? kept.map(each) : kept;
}

function clampNumber(value: unknown, min: number, max: number): unknown {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : value;
}

function wholeAtLeast(value: unknown, min: number): unknown {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.round(value)) : value;
}

/** "#abc", "ABCDEF" or " #AbCdEf " as "#AABBCC" style six digit hex; null
 * when the value is not a hex color at all. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/^#/, "");
  if (/^[0-9A-Fa-f]{6}$/.test(digits)) return `#${digits.toUpperCase()}`;
  if (/^[0-9A-Fa-f]{3}$/.test(digits)) {
    return `#${[...digits].map((d) => d + d).join("").toUpperCase()}`;
  }
  return null;
}

function positiveSize(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeNormalizedBox(box: unknown): unknown {
  if (!isRecord(box)) return box;
  return {
    ...box,
    x: clampNumber(box.x, 0, 1),
    y: clampNumber(box.y, 0, 1),
    width: clampNumber(box.width, 0, 1),
    height: clampNumber(box.height, 0, 1),
  };
}

function normalizeIntakeImage(image: unknown): unknown {
  if (!isRecord(image)) return image;
  const out: Loose = { ...image, distinctProducts: wholeAtLeast(image.distinctProducts, 0) };
  if (Array.isArray(image.products)) {
    out.products = image.products
      // A product with no area cannot be cut out; drop it rather than the pack.
      .filter((p) => !isRecord(p) || !isRecord(p.box) || (positiveSize(p.box.width) && positiveSize(p.box.height)))
      .slice(0, 12)
      .map((p) => (isRecord(p) ? { ...p, label: cutString(p.label, 120), box: normalizeNormalizedBox(p.box) } : p));
  }
  if (Array.isArray(image.boundingBoxes)) {
    out.boundingBoxes = image.boundingBoxes
      .filter((b) => !isRecord(b) || (positiveSize(b.width) && positiveSize(b.height)))
      .map((b) => (isRecord(b) ? { ...b, x: clampNumber(b.x, 0, Infinity), y: clampNumber(b.y, 0, Infinity) } : b));
  }
  return out;
}

function normalizeSellerIntent(intent: unknown): unknown {
  if (!isRecord(intent)) return intent;
  const cut120 = (item: unknown) => cutString(item, 120);
  return {
    ...intent,
    featureOnly: cutString(intent.featureOnly, 120),
    exclude: cutArray(intent.exclude, 8, cut120),
    mustKeep: cutArray(intent.mustKeep, 8, cut120),
    styleNotes: cutString(intent.styleNotes, 400),
  };
}

/** An intake answer brought inside IntakeResult's bounds. */
export function normalizeIntakeAnswer(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Loose = { ...raw };
  if (Array.isArray(raw.images)) out.images = raw.images.map(normalizeIntakeImage);
  if (raw.sellerIntent !== undefined) out.sellerIntent = normalizeSellerIntent(raw.sellerIntent);
  return out;
}

/** A product analysis answer brought inside ProductProfile's bounds. */
export function normalizeProductProfileAnswer(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Loose = {
    ...raw,
    productCount: wholeAtLeast(raw.productCount, 1),
    name: cutString(raw.name, 120),
    materials: cutArray(raw.materials, 8),
    features: cutArray(raw.features, 8),
    benefits: cutArray(raw.benefits, 8),
    useContexts: cutArray(raw.useContexts, 6),
  };
  if (Array.isArray(raw.dominantColors)) {
    out.dominantColors = raw.dominantColors
      .map((color) => {
        if (!isRecord(color)) return color;
        const hex = normalizeHex(color.hex);
        return hex ? { ...color, hex } : null;
      })
      // A color with no readable hex is dropped; the others are kept.
      .filter((color) => color !== null)
      .slice(0, 6);
  }
  return out;
}

/** IntakeResult as model answers are validated (see normalizeIntakeAnswer). */
export const IntakeAnswer = z.preprocess(normalizeIntakeAnswer, IntakeResult);

/** ProductProfile as model answers are validated (see
 * normalizeProductProfileAnswer). */
export const ProductProfileAnswer = z.preprocess(normalizeProductProfileAnswer, ProductProfile);

export type Hex = z.infer<typeof Hex>;
export type ProductProfile = z.infer<typeof ProductProfile>;
export type Shot = z.infer<typeof Shot>;
/** How a shot is produced, for example "deterministic" or "video_generate". */
export type ShotMethod = Shot["method"];
export type ShotList = z.infer<typeof ShotList>;
export type LlmShot = z.infer<typeof LlmShot>;
export type LlmShotList = z.infer<typeof LlmShotList>;
export type QCVerdict = z.infer<typeof QCVerdict>;
export type IntakeImageResult = z.infer<typeof IntakeImageResult>;
export type SellerIntent = z.infer<typeof SellerIntent>;
export type NormalizedBox = z.infer<typeof NormalizedBox>;
export type IntakeProduct = z.infer<typeof IntakeProduct>;
export type IntakeResult = z.infer<typeof IntakeResult>;
export type TargetPick = z.infer<typeof TargetPick>;

/** JSON Schema for a Zod schema, ready to send as a tool or response schema. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/** Keywords Anthropic strict tool use rejects (structured outputs docs,
 * checked 2026-09-28, docs/verification.md). The Zod schema still enforces
 * them client side after the call. */
const STRICT_UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
]);

/** String formats strict tool use accepts; any other format is dropped. */
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function toStrict(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(toStrict);
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (STRICT_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "format" && !(typeof value === "string" && STRICT_STRING_FORMATS.has(value))) continue;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      // Property names are data: a field called "pattern" is kept.
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, toStrict(sub)]),
      );
      continue;
    }
    // Enum lists and required lists are data, not subschemas.
    out[key] = key === "enum" || key === "required" || key === "const" ? value : toStrict(value);
  }
  // minItems supports only 0 and 1.
  if (typeof out.minItems === "number" && out.minItems > 1) {
    out.minItems = 1;
  }
  if (out.type === "object" || out.properties !== undefined) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * JSON Schema for an Anthropic strict tool (`strict: true`): the Zod schema
 * with the keywords strict mode does not support removed, minItems clamped
 * to 1 and additionalProperties false on every object. The API then
 * guarantees the tool input matches this shape; the dropped bounds (numeric
 * ranges, lengths, patterns, maxItems) are still checked by safeParse.
 */
export function strictToolSchema(schema: z.ZodType): Record<string, unknown> {
  return toStrict(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/**
 * JSON Schema for OpenAI strict structured outputs (docs/phases/PHASE_17.md
 * workstream 2): every property listed in required, optional fields as a
 * union with null, additionalProperties false on every object, the
 * supported bounds (minItems, maxItems, minimum, maximum, pattern, format)
 * kept and the rest (minLength, maxLength, allOf, not, conditionals)
 * dropped. Throws when the schema breaks OpenAI's size limits (5,000
 * properties, 10 levels of nesting, 1,000 enum values).
 *
 * The OpenAI adapter applies the same conversion to whatever schema a
 * request carries, and removes the nulls on optional fields from the
 * answer again, so the lenient answer schemas (IntakeAnswer,
 * ProductProfileAnswer, TargetPickAnswer, QuestionPlanAnswer) parse it
 * unchanged.
 */
export function openaiStrictSchema(schema: z.ZodType): Record<string, unknown> {
  const out = openaiStrictJsonSchema(z.toJSONSchema(schema));
  const problems = openaiSchemaLimitProblems(out);
  if (problems.length > 0) {
    throw new Error(`Schema breaks the OpenAI strict schema limits: ${problems.join("; ")}`);
  }
  return out;
}
