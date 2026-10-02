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
import { addedOverlaysIntake, restrictedGoodsIntake, type RestrictedGoodsKey } from "@curvi/pipeline/seed";

/** How long a preflight answer is reused. */
export const PREFLIGHT_FRESH_MS = 24 * 60 * 60 * 1000;

/** The recipe and provider that actually returned the answer, after standby
 * selection and provider failover. Absent on legacy cached answers. */
export interface RecipeExecution {
  recipe: { key: string; version: number; recipeId: string | null; source: "db" | "seed" };
  provider: string;
}

export interface PreflightIntake {
  /** Intake's answer for this one photo. */
  image: IntakeImageResult;
  /** The note parsed into intent, when intake returned it. */
  sellerIntent?: SellerIntent;
  /** noteKey of the note the answer was given for. */
  noteKey: string;
  /** The intake recipe the answer came from. */
  recipe: { key: string; version: number };
  execution?: RecipeExecution;
  /** When the preflight asked, ISO 8601. */
  at: string;
}

/** True when this intake recipe's prompt asks for addedOverlays
 * (addedOverlaysIntake). */
export function intakeAsksAddedOverlays(recipe: { key: string; version: number }): boolean {
  return recipe.key === addedOverlaysIntake.key && recipe.version >= addedOverlaysIntake.minVersion;
}

/** True when this intake recipe's prompt asks for restrictedCategory
 * (restrictedGoodsIntake, PHASE_19 P19-29). */
export function intakeAsksRestrictedGoods(recipe: { key: string; version: number }): boolean {
  return recipe.key === restrictedGoodsIntake.key && recipe.version >= restrictedGoodsIntake.minVersion;
}

/**
 * The intake answer with addedOverlays and restrictedCategory kept only when
 * the recipe asked for them. Strict tool use makes every recipe version
 * answer both fields, so under an older prompt the model guesses: a guessed
 * true would leave a clean kept photo out of eBay and Google, and a guessed
 * category would stop an assistant's pack. Pure: returns the answer
 * untouched when the recipe asked or nothing is set.
 */
export function trustedIntakeAnswer(intake: IntakeResult, recipe: { key: string; version: number }): IntakeResult {
  const dropOverlays = !intakeAsksAddedOverlays(recipe) && intake.images.some((image) => image.addedOverlays === true);
  const dropRestricted =
    !intakeAsksRestrictedGoods(recipe) && intake.images.some((image) => image.restrictedCategory !== null);
  if (!dropOverlays && !dropRestricted) {
    return intake;
  }
  return {
    ...intake,
    images: intake.images.map((image) => ({
      ...image,
      ...(dropOverlays ? { addedOverlays: false } : {}),
      ...(dropRestricted ? { restrictedCategory: null } : {}),
    })),
  };
}

/** The prohibited goods categories intake named in a trusted answer
 * (trustedIntakeAnswer), each once, in image order. */
export function restrictedCategoriesOf(intake: IntakeResult): RestrictedGoodsKey[] {
  const found: RestrictedGoodsKey[] = [];
  for (const image of intake.images) {
    if (image.restrictedCategory && !found.includes(image.restrictedCategory)) {
      found.push(image.restrictedCategory);
    }
  }
  return found;
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
  screening?: { recipeId: string | null; providers: readonly string[] },
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
    if (screening) {
      const executed = preflight.execution;
      // Old caches recorded the assigned version even when a different
      // standby ran. Assistant screening requires affirmative provenance;
      // ordinary web packs retain the legacy cache behavior.
      if (
        !intakeAsksRestrictedGoods(recipe) ||
        !screening.recipeId?.trim() ||
        !executed ||
        executed.recipe?.source !== "db" ||
        executed.recipe.recipeId !== screening.recipeId ||
        executed.recipe.key !== recipe.key ||
        executed.recipe.version !== recipe.version ||
        !screening.providers.includes(executed.provider)
      ) {
        return null;
      }
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
