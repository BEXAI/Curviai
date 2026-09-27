import { z } from "zod";
import registryJson from "./registry.json" with { type: "json" };

export const BackgroundRule = z.object({
  type: z.enum(["solid", "any", "consistent", "white_or_transparent", "white_preferred"]),
  rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]).optional(),
  tolerance: z.number().min(0).optional(),
});

export const FillRule = z.object({
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
});

export const ChannelSpec = z.object({
  id: z.string().min(1),
  verified: z.boolean(),
  source: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  minLongSide: z.number().int().positive().optional(),
  maxLongSide: z.number().int().positive().optional(),
  maxMegapixels: z.number().positive().optional(),
  formats: z.array(z.enum(["jpg", "png", "tif", "gif", "webp", "mp4", "mov"])).optional(),
  colorSpace: z.literal("sRGB").optional(),
  maxBytes: z.number().int().positive().optional(),
  maxCount: z.number().int().positive().optional(),
  background: BackgroundRule.optional(),
  fill: FillRule.optional(),
  textAllowed: z.boolean().optional(),
  propsAllowed: z.boolean().optional(),
  overlaysAllowed: z.boolean().optional(),
  badgeAllowed: z.boolean().optional(),
  iptcDigitalSourceTypeRequiredIfAI: z.boolean().optional(),
  naming: z.string().optional(),
  safeZone: z.object({ top: z.number().int().min(0), bottom: z.number().int().min(0) }).optional(),
  fps: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
});

export const Registry = z.object({
  version: z.number().int().positive(),
  specs: z.array(ChannelSpec).min(1),
});

export type BackgroundRule = z.infer<typeof BackgroundRule>;
export type FillRule = z.infer<typeof FillRule>;
export type ChannelSpec = z.infer<typeof ChannelSpec>;
export type Registry = z.infer<typeof Registry>;

let cached: Registry | null = null;

/** Parse and validate the bundled registry. Throws if the JSON drifts from the schema. */
export function loadRegistry(): Registry {
  if (!cached) {
    cached = Registry.parse(registryJson);
  }
  return cached;
}

export function listSpecs(): ChannelSpec[] {
  return loadRegistry().specs;
}

export function getSpec(id: string): ChannelSpec {
  const spec = loadRegistry().specs.find((s) => s.id === id);
  if (!spec) {
    throw new Error(`Unknown channel spec: ${id}`);
  }
  return spec;
}

export function hasSpec(id: string): boolean {
  return loadRegistry().specs.some((s) => s.id === id);
}

/** Marketplace channels must never carry a badge or watermark. Social exports may. */
export function isMarketplaceSpec(id: string): boolean {
  return /^(amazon|shopify|google|etsy|ebay|walmart|tiktokshop)\./.test(id);
}

export interface FilenameVars {
  sku?: string;
  seoSlug?: string;
  n?: number;
}

/**
 * Render a spec naming template like "{sku}.MAIN.jpg", "{sku}.PT{nn}.jpg" or
 * "{seoSlug}-{n}.jpg". {nn} is the sequence number padded to two digits.
 */
export function filenameFor(spec: ChannelSpec, vars: FilenameVars): string {
  if (!spec.naming) {
    throw new Error(`Spec ${spec.id} has no naming template`);
  }
  const n = vars.n ?? 1;
  let out = spec.naming;
  if (out.includes("{sku}")) {
    out = out.replaceAll("{sku}", requireVar(spec.id, "sku", vars.sku));
  }
  if (out.includes("{seoSlug}")) {
    out = out.replaceAll("{seoSlug}", requireVar(spec.id, "seoSlug", vars.seoSlug));
  }
  return out.replaceAll("{nn}", String(n).padStart(2, "0")).replaceAll("{n}", String(n));
}

function requireVar(specId: string, name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Spec ${specId} naming requires ${name}`);
  }
  // Interpolated values become file and zip entry names. Strip anything that
  // could traverse paths (zip slip) or break marketplace upload tooling.
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "");
  if (!sanitized) {
    throw new Error(`Spec ${specId} naming var ${name} is empty after sanitization`);
  }
  return sanitized;
}

/** The dimension boundaries a rendered file must satisfy for this spec. */
export function dimensionBounds(spec: ChannelSpec): {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  minLongSide: number;
  maxLongSide: number;
} {
  return {
    minWidth: spec.minWidth ?? 1,
    minHeight: spec.minHeight ?? 1,
    maxWidth: spec.maxWidth ?? spec.width ?? Number.MAX_SAFE_INTEGER,
    maxHeight: spec.maxHeight ?? spec.height ?? Number.MAX_SAFE_INTEGER,
    minLongSide: spec.minLongSide ?? 1,
    maxLongSide: spec.maxLongSide ?? Number.MAX_SAFE_INTEGER,
  };
}
