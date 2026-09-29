/**
 * The seller's output options as the services handle them (PHASE_15 items
 * 24 to 28): resolving a request's options against the brand kit, the plan
 * and the flags, reading them back from generation_jobs.output_options, and
 * the estimate inputs every hold uses. Pure and client safe, so the new pack
 * form, createJob and the demo build the same estimate inputs from one
 * function and their figures agree.
 */

import {
  DEFAULT_OUTPUT_OPTIONS,
  keepMediaIdsFor,
  normalizeOutputOptions,
  outputOptionsKey,
  planFlagsOf,
  resolveColorHex,
  resolveOutputOptions,
  HEX,
  ResolvedOutputOptions,
  type NormalizedOutputOptions,
  type OutputOptionsInput,
  type OutputPlanFlags,
  type PhotoBackgroundChoice,
  type PlanPhoto,
} from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { planAngleKey, type AngleRole } from "@curvi/pipeline/seller-inputs";
import type { EstimatePhoto, EstimateSellerInputs } from "@/lib/pack-estimate";

/** Why createJob refused a pack's options. Routes map invalid_options to
 * 400, upgrade_required to 402 and feature_unavailable to 422. */
export type OutputOptionsRefusal = "invalid_options" | "upgrade_required" | "feature_unavailable";

export const INVALID_OPTIONS_MESSAGE = "These image choices could not be read. Pick them again and try once more.";
export const BRAND_COLOR_MISSING_MESSAGE = "That brand color is no longer in your brand kit. Pick another color.";
export const BRAND_COLOR_UPGRADE_MESSAGE =
  "Your plan does not include brand kits, so brand colors are not available. Pick another color or upgrade on the billing page.";
export const OPTIONS_UNAVAILABLE_MESSAGE =
  "Image choices are paused right now. Pick Marketplace ready to start this pack.";

/** One of the pack's photos, as createJob and the demo know it. */
export interface OutputPhoto {
  /** R2 key in db mode, a synthetic id in the demo. */
  id: string;
  angle?: AngleRole | null;
  width?: number | null;
  height?: number | null;
}

export interface ResolveJobOutputArgs {
  /** The request's options; absent means today's pack. */
  input: OutputOptionsInput | null | undefined;
  mode: "listing" | "concept";
  /** The env flag and the kill switch are both on. */
  enabled: boolean;
  /** The workspace brand kit colors, in kit order. */
  brandColors: readonly string[];
  /** The plan includes brand kits. */
  brandKitsAllowed: boolean;
  /** The pack's photos (images only), in pack order. */
  photos: readonly OutputPhoto[];
  /** Background per photo (P1), by photo id: uploads[].background. A photo
   * with none, or with "pack", follows the pack's switch. */
  photoBackgrounds?: Readonly<Partial<Record<string, PhotoBackgroundChoice>>>;
}

export type ResolvedJobOutput =
  | {
      ok: true;
      /** What generation_jobs.output_options stores and the payload carries. */
      resolved: ResolvedOutputOptions;
      /** The planner flags for the pack's photos. */
      flags: OutputPlanFlags;
    }
  | { ok: false; reason: OutputOptionsRefusal; message: string };

/** Canonical key of today's pack. */
const DEFAULT_KEY = outputOptionsKey(DEFAULT_OUTPUT_OPTIONS);

/** True when the options differ from today's pack (lookBase never counts). */
export function isNonDefaultOutput(options: NormalizedOutputOptions | ResolvedOutputOptions | OutputOptionsInput | null | undefined): boolean {
  return outputOptionsKey(options ?? null) !== DEFAULT_KEY;
}

/** Each upload's own background choice (P1 "Background per photo"), by R2
 * key; an upload without one follows the pack. */
export function photoBackgroundsOf(
  uploads: ReadonlyArray<{ key: string; background?: PhotoBackgroundChoice }> | null | undefined,
): Partial<Record<string, PhotoBackgroundChoice>> {
  const out: Partial<Record<string, PhotoBackgroundChoice>> = {};
  for (const upload of uploads ?? []) {
    if (upload.background) {
      out[upload.key] = upload.background;
    }
  }
  return out;
}

/**
 * True when a photo's own background choice (P1 "Background per photo")
 * differs from what the pack's switch gives it: a kept photo in a Remove
 * pack, or a removed photo in a Keep pack. Such a request is not today's
 * pack even with default options.
 */
export function hasPhotoBackgroundOverride(
  options: OutputOptionsInput | null | undefined,
  photoBackgrounds: Readonly<Partial<Record<string, PhotoBackgroundChoice>>> | null | undefined,
): boolean {
  const pack = options?.background ?? "remove";
  return Object.values(photoBackgrounds ?? {}).some((choice) => choice !== undefined && choice !== "pack" && choice !== pack);
}

/** The first valid brand kit hex, else the seeded fallback: the color
 * sweep_brand uses today, snapshotted so a later kit edit never changes it. */
export function brandSweepHexFor(brandColors: readonly string[]): string {
  const found = brandColors.map((c) => c.trim()).find((c) => HEX.test(c));
  return (found ?? stillStyle.fallbackBrandHex).toUpperCase();
}

function planPhotosOf(photos: readonly OutputPhoto[]): PlanPhoto[] {
  return photos.map((photo) => ({
    id: photo.id,
    ...(photo.angle ? { angle: planAngleKey(photo.angle) } : {}),
    ...(typeof photo.width === "number" && photo.width > 0 ? { width: photo.width } : {}),
    ...(typeof photo.height === "number" && photo.height > 0 ? { height: photo.height } : {}),
  }));
}

/**
 * Resolves a pack request's options (PHASE_15 item 24):
 * 1. Concept mode normalizes to today's pack.
 * 2. Options other than today's pack are refused while the env flag or the
 *    kill switch is off (feature_unavailable), so an older runner never
 *    receives a Keep request it would run as a Remove pack.
 * 3. A brand color needs a plan with brand kits (upgrade_required) and a kit
 *    color at that index (invalid_options).
 * 4. The color and the brand sweep are snapshotted as hexes, and a photo is
 *    kept when its own choice says keep (P1 "Background per photo"), or it
 *    follows the pack and the pack keeps its backgrounds.
 */
export function resolveJobOutput(args: ResolveJobOutputArgs): ResolvedJobOutput {
  let normalized: NormalizedOutputOptions;
  try {
    normalized = args.mode === "concept" ? DEFAULT_OUTPUT_OPTIONS : normalizeOutputOptions(args.input ?? null);
  } catch {
    return { ok: false, reason: "invalid_options", message: INVALID_OPTIONS_MESSAGE };
  }
  // Concept packs have no real photo to keep.
  const perPhoto = args.mode === "concept" ? undefined : args.photoBackgrounds;
  if (!args.enabled && (isNonDefaultOutput(normalized) || hasPhotoBackgroundOverride(normalized, perPhoto))) {
    return { ok: false, reason: "feature_unavailable", message: OPTIONS_UNAVAILABLE_MESSAGE };
  }
  if (normalized.color.kind === "brand" && !args.brandKitsAllowed) {
    return { ok: false, reason: "upgrade_required", message: BRAND_COLOR_UPGRADE_MESSAGE };
  }
  const colorHex = resolveColorHex(normalized.color, args.brandColors);
  if (colorHex === null) {
    return { ok: false, reason: "invalid_options", message: BRAND_COLOR_MISSING_MESSAGE };
  }
  const photos = planPhotosOf(args.photos);
  const resolved = resolveOutputOptions(normalized, {
    colorHex,
    brandSweepHex: brandSweepHexFor(args.brandColors),
    keepMediaIds: keepMediaIdsFor(
      normalized,
      photos.map((photo) => photo.id),
      perPhoto,
    ),
  });
  return { ok: true, resolved, flags: planFlagsOf(resolved, photos) };
}

/**
 * A job row's stored options (generation_jobs.output_options), parsed with
 * the shared schema. SQL NULL (every pack before PHASE_15) reads as null,
 * which means today's pack. Anything the schema refuses throws: callers fail
 * closed rather than run a pack on options they cannot read.
 */
export function parseStoredOutputOptions(stored: unknown): ResolvedOutputOptions | null {
  if (stored === null || stored === undefined) {
    return null;
  }
  return ResolvedOutputOptions.parse(stored);
}

/** parseStoredOutputOptions, answering undefined instead of throwing. */
export function readStoredOutputOptions(stored: unknown): ResolvedOutputOptions | null | undefined {
  try {
    return parseStoredOutputOptions(stored);
  } catch {
    return undefined;
  }
}

/**
 * What the credit estimate needs from the options, the same for the form,
 * the createJob hold and the demo plan: nothing for today's pack (its hold
 * stays the reference product's, exactly as before PHASE_15), otherwise the
 * plan flags, the photos in pack order and the chosen color. A pack whose
 * only difference is a photo kept on its own (P1) counts as not today's.
 */
export function outputEstimateInputs(
  resolved:
    | (Pick<ResolvedOutputOptions, "background" | "keepMediaIds" | "extras" | "fit" | "color" | "colorHex"> &
        Partial<Pick<ResolvedOutputOptions, "sceneCount" | "scenePreset" | "logo" | "productSize" | "enlarge" | "graphicsColor" | "bundle">>)
    | null
    | undefined,
  photos: readonly OutputPhoto[],
): Pick<EstimateSellerInputs, "output" | "photos" | "colorHex"> {
  const perPhotoKeep = resolved?.background === "remove" && resolved.keepMediaIds.length > 0;
  const choices = resolved
    ? {
        v: 1 as const,
        background: resolved.background,
        color: resolved.color,
        fit: resolved.fit,
        extras: resolved.extras,
        ...(resolved.sceneCount !== undefined ? { sceneCount: resolved.sceneCount } : {}),
        ...(resolved.scenePreset !== undefined ? { scenePreset: resolved.scenePreset } : {}),
        ...(resolved.logo !== undefined ? { logo: resolved.logo } : {}),
        ...(resolved.productSize !== undefined ? { productSize: resolved.productSize } : {}),
        ...(resolved.enlarge !== undefined ? { enlarge: resolved.enlarge } : {}),
        ...(resolved.graphicsColor !== undefined ? { graphicsColor: resolved.graphicsColor } : {}),
        ...(resolved.bundle !== undefined ? { bundle: resolved.bundle } : {}),
      }
    : null;
  if (!resolved || (!perPhotoKeep && !isNonDefaultOutput(choices))) {
    return {};
  }
  const estimatePhotos: EstimatePhoto[] = photos.map((photo) => ({
    ...(photo.angle ? { angle: photo.angle } : {}),
    ...(typeof photo.width === "number" && photo.width > 0 ? { width: photo.width } : {}),
    ...(typeof photo.height === "number" && photo.height > 0 ? { height: photo.height } : {}),
  }));
  return {
    output: planFlagsOf(resolved, planPhotosOf(photos)),
    photos: estimatePhotos,
    colorHex: resolved.colorHex,
  };
}
