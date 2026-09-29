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
  /**
   * When true, width and height are the only accepted size (social feeds,
   * pins and banners crop or reject anything else). When false or absent,
   * width and height are the size we render at and the min and max fields
   * give the accepted range.
   */
  exactSize: z.boolean().optional(),
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
  /**
   * False when the channel refuses added borders or flat added space around
   * the photo (eBay, TikTok Shop). Absent means added space is accepted.
   */
  bordersAllowed: z.boolean().optional(),
  badgeAllowed: z.boolean().optional(),
  iptcDigitalSourceTypeRequiredIfAI: z.boolean().optional(),
  naming: z.string().optional(),
  safeZone: z.object({ top: z.number().int().min(0), bottom: z.number().int().min(0) }).optional(),
  fps: z.number().int().positive().optional(),
  maxSeconds: z.number().int().positive().optional(),
});

export const Registry = z.object({
  version: z.number().int().positive(),
  specs: z.array(
    ChannelSpec.refine((spec) => !spec.exactSize || (spec.width !== undefined && spec.height !== undefined), {
      message: "exactSize needs both width and height",
    }),
  ).min(1),
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

/**
 * The one selection rule every part of a pack follows (Update.md 2.11): the
 * planner, the runner's channel fitting and the web estimate and hold all
 * ask this. A spec id selects only itself, so a seller who ticked
 * meta.feed_1x1 gets no 4x5 or story crop, and amazon.main alone gets no A+
 * banner; a bare family ("amazon") or a group prefix ("amazon.aplus")
 * selects every spec under it. A spec the registry does not know is never
 * selected.
 */
export function isSpecSelected(channels: readonly string[], specId: string): boolean {
  if (!hasSpec(specId)) {
    return false;
  }
  return channels.some((c) => c === specId || (!hasSpec(c) && specId.startsWith(`${c}.`)));
}

/** The registry specs a channel selection picks, in registry order. */
export function selectedSpecIds(channels: readonly string[]): string[] {
  return listSpecs()
    .map((spec) => spec.id)
    .filter((id) => isSpecSelected(channels, id));
}

/**
 * True when a selected channel string, a spec id or a family or group
 * prefix, is marketplace bound: every spec it selects is a marketplace spec.
 * Concept packs leave these out before planning (plan 2.7).
 */
export function isMarketplaceChannel(channel: string): boolean {
  const picked = selectedSpecIds([channel]);
  return picked.length > 0 && picked.every((id) => isMarketplaceSpec(id));
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

/**
 * The dimension boundaries a rendered file must satisfy for this spec. An
 * exactSize spec accepts only width x height. Otherwise width and height
 * cap the size when no explicit maximum is given, and the minimums default
 * to 1.
 */
export function dimensionBounds(spec: ChannelSpec): {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  minLongSide: number;
  maxLongSide: number;
} {
  if (spec.exactSize && spec.width !== undefined && spec.height !== undefined) {
    const long = Math.max(spec.width, spec.height);
    return {
      minWidth: spec.width,
      minHeight: spec.height,
      maxWidth: spec.width,
      maxHeight: spec.height,
      minLongSide: long,
      maxLongSide: long,
    };
  }
  return {
    minWidth: spec.minWidth ?? 1,
    minHeight: spec.minHeight ?? 1,
    maxWidth: spec.maxWidth ?? spec.width ?? Number.MAX_SAFE_INTEGER,
    maxHeight: spec.maxHeight ?? spec.height ?? Number.MAX_SAFE_INTEGER,
    minLongSide: spec.minLongSide ?? 1,
    maxLongSide: spec.maxLongSide ?? Number.MAX_SAFE_INTEGER,
  };
}

/** True when the naming template numbers its files ({n} or {nn}). */
export function namingHasSequence(spec: ChannelSpec): boolean {
  return !!spec.naming && /\{nn?\}/.test(spec.naming);
}

/**
 * The most files one product may have for this spec, or null for no limit.
 * An explicit maxCount wins (amazon.secondary takes 8). A naming template
 * without a sequence slot ("{sku}.MAIN.jpg") can only name one file per
 * product, so it allows exactly one.
 */
export function channelFileLimit(spec: ChannelSpec): number | null {
  if (spec.maxCount !== undefined) {
    return spec.maxCount;
  }
  if (spec.naming && !namingHasSequence(spec)) {
    return 1;
  }
  return null;
}

/**
 * True when the spec's background rule asks for white: a solid pure white
 * fill, white or transparent, or white preferred (TikTok Shop's policy asks
 * for a pure white main image). Derived from the registry rule, never from a
 * list of ids, so a new registry entry is covered by its rule alone.
 */
export function requiresWhiteBackground(spec: ChannelSpec): boolean {
  const rule = spec.background;
  if (!rule) {
    return false;
  }
  switch (rule.type) {
    case "solid":
      return rule.rgb !== undefined && rule.rgb.every((channel) => channel === 255);
    case "white_or_transparent":
    case "white_preferred":
      return true;
    case "any":
    case "consistent":
      return false;
  }
}

/** True when width by height is the only size the spec accepts. */
export function isExactSize(spec: ChannelSpec): boolean {
  return spec.exactSize === true;
}

/** False when the channel refuses added borders or flat added space. */
export function allowsAddedBorders(spec: ChannelSpec): boolean {
  return spec.bordersAllowed !== false;
}

/** True when the channel refuses added text or overlays on the image. */
export function refusesOverlays(spec: ChannelSpec): boolean {
  return spec.textAllowed === false || spec.overlaysAllowed === false;
}
