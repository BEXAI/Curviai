/**
 * The preflight's intake answer as a pack carries it (docs/phases/
 * PHASE_14.md workstream 4). The web app attaches each photo's preflight
 * intake to the pack payload; the runner reuses the answers instead of a
 * second intake call only when every photo it judges has one that is fresh,
 * was given for the same seller note, and came from the recipe version this
 * job was assigned. Anything else runs intake as before.
 */

import { createHash } from "node:crypto";
import { IntakeImageResult, SellerIntent, type IntakeResult } from "@curvi/pipeline/schemas";

/** How long a preflight answer is reused. */
export const PREFLIGHT_FRESH_MS = 24 * 60 * 60 * 1000;

export interface PreflightIntake {
  /** Intake's answer for this one photo. */
  image: IntakeImageResult;
  /** The note parsed into intent, when intake returned it. */
  sellerIntent?: SellerIntent;
  /** noteKey of the note the answer was given for. */
  noteKey: string;
  /** The intake recipe the answer came from. */
  recipe: { key: string; version: number };
  /** When the preflight asked, ISO 8601. */
  at: string;
}

/** A stable key for the seller's note: a sha256 of the trimmed text, so an
 * absent and an empty note are the same note. */
export function noteKey(note: string | null | undefined): string {
  return createHash("sha256")
    .update((note ?? "").trim())
    .digest("hex");
}

/** Clock skew tolerated between the web app that asked and the worker that
 * reuses the answer. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** True when the answer is from the last PREFLIGHT_FRESH_MS (and not from
 * further in the future than the clock skew allows). */
export function preflightFresh(at: string, now: Date, freshMs = PREFLIGHT_FRESH_MS): boolean {
  const asked = Date.parse(at);
  if (!Number.isFinite(asked)) {
    return false;
  }
  const age = now.getTime() - asked;
  return age > -CLOCK_SKEW_MS && age < freshMs;
}

/**
 * The intake answer for these photos from their preflights, in the same
 * order, or null when any photo has none that can be reused. Every answer is
 * validated again, since the payload crossed a queue.
 */
export function reusablePreflightIntake(
  judged: ReadonlyArray<{ preflight?: PreflightIntake }>,
  note: string | null | undefined,
  recipe: { key: string; version: number },
  now: Date,
): IntakeResult | null {
  if (judged.length === 0) {
    return null;
  }
  const key = noteKey(note);
  const images: IntakeImageResult[] = [];
  let sellerIntent: SellerIntent | undefined;
  for (const photo of judged) {
    const preflight = photo.preflight;
    if (
      !preflight ||
      preflight.noteKey !== key ||
      preflight.recipe?.key !== recipe.key ||
      preflight.recipe?.version !== recipe.version ||
      !preflightFresh(preflight.at, now)
    ) {
      return null;
    }
    const image = IntakeImageResult.safeParse(preflight.image);
    if (!image.success) {
      return null;
    }
    images.push(image.data);
    if (!sellerIntent && preflight.sellerIntent) {
      const intent = SellerIntent.safeParse(preflight.sellerIntent);
      sellerIntent = intent.success ? intent.data : undefined;
    }
  }
  return { images, ...(sellerIntent ? { sellerIntent } : {}) };
}
