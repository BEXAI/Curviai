/**
 * Pure helpers for how the job page, the reveal and the downloads show a
 * delivered file (PHASE_15 job page and item 34): the aspect box a preview
 * sits in, read from the registry through canvasSizeFor, whether a checkerboard
 * belongs behind it, and which shot cards the board shows. Client safe.
 */

import { canvasSizeFor, EXTRA_FAMILIES } from "@curvi/pipeline/output-options";
import { getSpec, hasSpec } from "@curvi/specs";
import { SELLER_OFF_COPY } from "@/lib/job-copy";
import type { JobShotView } from "@/lib/services/types";

/** Width and height of a preview's box, in the spec's canvas ratio. */
export interface PreviewAspect {
  width: number;
  height: number;
}

/** A square box, for a file whose channel the registry does not know. */
export const SQUARE_ASPECT: PreviewAspect = { width: 1, height: 1 };

/** The box for the first spec the registry knows, else a square. */
export function previewAspect(specIds: ReadonlyArray<string | null | undefined>): PreviewAspect {
  const specId = specIds.find((id): id is string => typeof id === "string" && hasSpec(id));
  if (!specId) {
    return SQUARE_ASPECT;
  }
  const { width, height } = canvasSizeFor(getSpec(specId));
  return { width, height };
}

/** The CSS aspect-ratio value for a box, e.g. "1080 / 1350". */
export function aspectRatioCss(aspect: PreviewAspect): string {
  return `${aspect.width} / ${aspect.height}`;
}

function baseShotType(shotType: string): string {
  return shotType.split(":")[0];
}

/** True for a shot whose file is a transparent PNG (the transparentPng family). */
export function isTransparentShot(shotType: string): boolean {
  return (EXTRA_FAMILIES.transparentPng as readonly string[]).includes(baseShotType(shotType));
}

/**
 * True for a downloaded file that may carry transparency: any PNG. The
 * preview draws the checkerboard on the image itself, so an opaque PNG hides
 * it completely and only real transparent pixels show it.
 */
export function mayBeTransparentFile(name: string): boolean {
  return name.toLowerCase().endsWith(".png");
}

/** True for the seller's own kept photo (PHASE_15 original_photo). */
export function isOriginalShot(shotType: string): boolean {
  return baseShotType(shotType) === "original_photo";
}

/** True for a shot in an extra family the seller turned off for this pack. */
export function isTurnedOffShot(shot: Pick<JobShotView, "status" | "label">): boolean {
  return shot.status === "skipped" && shot.label === SELLER_OFF_COPY.label;
}

/** The shot cards the board shows: every shot but the ones the seller turned off. */
export function boardShots<T extends Pick<JobShotView, "status" | "label">>(shots: readonly T[]): T[] {
  return shots.filter((shot) => !isTurnedOffShot(shot));
}

/** One card of a grouped section, with the title the group gives it. */
export interface GroupedShot<T> {
  shot: T;
  title: string;
}

/**
 * The board's sections (PHASE_16 workstream 3): the carousel's slides
 * together in slide order ("Slide 1" ...), and the ad variants together
 * ("Ad 1" ...), each in plan order, which is the order the planner numbered
 * them. Every other shot stays in the main grid. A skipped entry for a whole
 * format (the carousel left out) stays in the main grid too, so its reason
 * shows where the other left out shots are.
 */
export function boardSections<T extends Pick<JobShotView, "shotType" | "status">>(
  shots: readonly T[],
): { shots: T[]; carousel: GroupedShot<T>[]; ads: GroupedShot<T>[] } {
  const out: { shots: T[]; carousel: GroupedShot<T>[]; ads: GroupedShot<T>[] } = { shots: [], carousel: [], ads: [] };
  for (const shot of shots) {
    const type = baseShotType(shot.shotType);
    if (shot.status !== "skipped" && type === "carousel_slide") {
      out.carousel.push({ shot, title: `Slide ${out.carousel.length + 1}` });
    } else if (shot.status !== "skipped" && type === "ad_variant") {
      out.ads.push({ shot, title: `Ad ${out.ads.length + 1}` });
    } else {
      out.shots.push(shot);
    }
  }
  return out;
}
