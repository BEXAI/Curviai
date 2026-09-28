/**
 * Source of truth Zod schemas for the pipeline (CURVI_BUILD_PLAN.md section 5.2,
 * verbatim). JSON Schema for tool or response formats is generated with
 * z.toJSONSchema via jsonSchemaFor below.
 */
import { z } from "zod";

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
  id: z.string(), type: z.enum(["amazon_main","alt_angle_white","cutout_png","sweep_gray","sweep_brand","lifestyle","infographic","dimensions","in_the_box","comparison","aplus_banner","shopify_hero","collection_thumb","social_1x1","social_4x5","social_9x16","social_2x3","video_spin","video_hero_6s","video_lifestyle_15s","video_ugc_hook"]),
  sourceMediaId: z.string(), method: z.enum(["deterministic","composite_generate","edit_generate","template","video_generate","avatar"]),
  channels: z.array(z.string()), stylePreset: z.string(), scene: z.string().max(400).optional(),
  callouts: z.array(z.string().max(40)).max(5).optional(), credits: z.number(), priority: z.number().int()
});

export const ShotList = z.object({ shots: z.array(Shot).max(40), skipped: z.array(z.object({ type: z.string(), reason: z.string() })) });

export const QCVerdict = z.object({
  pass: z.boolean(), fidelity: z.number().min(0).max(1), issues: z.array(z.enum(["label_changed","logo_changed","shape_changed","color_shift","extra_items","artifact","bad_shadow","text_in_main","unrealistic_scale","other"])),
  repairHint: z.string().max(300)
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
  flags: z.object({
    nudity: z.boolean(),
    weapons: z.boolean(),
    drugs: z.boolean(),
    prohibited: z.boolean(),
    realPersonMainSubject: z.boolean(),
  }),
});

export const IntakeResult = z.object({ images: z.array(IntakeImageResult).min(1) });

export type Hex = z.infer<typeof Hex>;
export type ProductProfile = z.infer<typeof ProductProfile>;
export type Shot = z.infer<typeof Shot>;
/** How a shot is produced, for example "deterministic" or "video_generate". */
export type ShotMethod = Shot["method"];
export type ShotList = z.infer<typeof ShotList>;
export type QCVerdict = z.infer<typeof QCVerdict>;
export type IntakeImageResult = z.infer<typeof IntakeImageResult>;
export type IntakeResult = z.infer<typeof IntakeResult>;

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
