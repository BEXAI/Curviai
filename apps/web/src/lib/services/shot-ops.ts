/**
 * Pure rules for the pack operations on a delivered pack: running a shot
 * that needs review again, adding a photo of an angle the planner skipped,
 * and the copy for a cancel. The db service does the writes; everything
 * that decides what may run, what it costs and which channels still have
 * room lives here, so it is unit tested without a database.
 *
 * Prices come from the planned shot (the runner repriced it from the seed)
 * or from the planner over the seed (CLAUDE.md rule 2); channel image limits
 * come from the spec registry.
 */

import { planFlagsOf, type ResolvedOutputOptions } from "@curvi/pipeline/output-options";
import { planShots } from "@curvi/pipeline/planner";
import { ProductProfile, Shot } from "@curvi/pipeline/schemas";
import { undeliverableShotMethods, type TierKey } from "@curvi/pipeline/seed";
import { channelFileLimit, getSpec, hasSpec } from "@curvi/specs";
import { ESTIMATE_REFERENCE_PRODUCT } from "@/lib/pack-estimate";

/** job_steps status the web app writes when a shot is queued to run again.
 * The board shows the shot as in progress from that row on. */
export const RERUN_STEP_STATUS = "rerun";

export type Angle = ProductProfile["photographedAngles"][number];

const ANGLES: ReadonlySet<string> = new Set(ProductProfile.shape.photographedAngles.element.options);

/** A shot left out of the pack over a channel's image limit passed every
 * check; running it again cannot put it in the pack. */
const CHANNEL_FULL_HINT = "as many images as it allows";

/** The planned shot stored on a shot's asset row, or null for rows written
 * before shots were stored (those shots cannot be run again). */
export function storedShot(qc: Record<string, unknown> | null | undefined): Shot | null {
  const parsed = Shot.safeParse(qc?.shot);
  return parsed.success ? parsed.data : null;
}

/** True when a shot that needs review may run again: its planned shot is
 * stored and it was not left out only because its channel was full. */
export function isRetryable(qc: Record<string, unknown> | null | undefined): boolean {
  if (!storedShot(qc)) {
    return false;
  }
  const hint = typeof qc?.repairHint === "string" ? qc.repairHint.toLowerCase() : "";
  return !hint.includes(CHANNEL_FULL_HINT);
}

/**
 * The angle a skipped shot is waiting for, from its planner row: the stage
 * names the shot ("alt_angle_white:back", or "amazon_main" and
 * "alt_angle_white:front" for the front) and the reason says it needs a
 * photo. Null for any other skipped shot.
 */
export function angleOfSkippedShot(stage: string | null | undefined, reason: string | null | undefined): Angle | null {
  if (!(reason ?? "").toLowerCase().includes("needs photo")) {
    return null;
  }
  if (stage === "amazon_main") {
    return "front";
  }
  const match = /^alt_angle_white:(.+)$/.exec(stage ?? "");
  return match && ANGLES.has(match[1]) ? (match[1] as Angle) : null;
}

/** How the board names an angle in its button and confirmation. */
export function angleLabel(angle: Angle): string {
  switch (angle) {
    case "45":
      return "three quarter";
    case "in_use":
      return "in use";
    default:
      return angle;
  }
}

/** The specs of `specIds` whose channel still has room for one more file,
 * given the files each spec already holds in the pack. */
export function specsWithRoom(specIds: readonly string[], existingFilesBySpec: Readonly<Record<string, number>>): string[] {
  return [...new Set(specIds)].filter((specId) => {
    if (!hasSpec(specId)) {
      return false;
    }
    const limit = channelFileLimit(getSpec(specId));
    return limit === null || (existingFilesBySpec[specId] ?? 0) < limit;
  });
}

/** Credits a follow up holds: the sum of its shots' seed prices, to the
 * ledger's one decimal. */
export function followUpCredits(shots: ReadonlyArray<Pick<Shot, "credits">>): number {
  return Math.round(shots.reduce((sum, shot) => sum + shot.credits, 0) * 10) / 10;
}

/**
 * The shot a retry runs: the stored plan, limited to the channels that
 * still have room. Null when none has room.
 */
export function retryShotFor(shot: Shot, existingFilesBySpec: Readonly<Record<string, number>>): Shot | null {
  const channels = specsWithRoom(shot.channels, existingFilesBySpec);
  return channels.length > 0 ? { ...shot, channels } : null;
}

/** The white shot types a new angle photo is planned as. */
const ANGLE_WHITE_TYPES: ReadonlySet<Shot["type"]> = new Set(["amazon_main", "alt_angle_white"]);

/**
 * The shots a new photo of `angle` unlocks, planned by the deterministic
 * planner (the same rules and seed prices as a first run) for the pack's
 * channels: the white image of that angle, or the main image and white
 * front image when the front was missing. Only shots made from the new
 * photo are kept, each on the channels that still have room, under the id
 * of the skipped card it replaces. Empty when no channel can take it.
 *
 * On a Keep pack (the photo in output.keepMediaIds) the photo ships as
 * itself: its original_photo takes the card's id, and a made white copy for
 * the channels that require white follows under its own id.
 */
export function planAngleShots(args: {
  angle: Angle;
  mediaKey: string;
  shotId: string;
  channels: readonly string[];
  tier: TierKey;
  existingFilesBySpec: Readonly<Record<string, number>>;
  /** The job's stored output options (PHASE_15), with the new photo in
   * keepMediaIds when the pack keeps its backgrounds. Absent or null plans
   * today's white shots; the color is applied at render time. */
  output?: ResolvedOutputOptions | null;
  /** The new photo's stored upright size, when the ingest check read it. */
  photoSize?: { width: number; height: number } | null;
  /** Intake saw added text, borders or watermarks on the new photo (its
   * upload preflight), so a kept copy skips the channels that refuse them,
   * as on a first run (applyAddedOverlays). */
  addedOverlays?: boolean;
}): Shot[] {
  const profile: ProductProfile = {
    ...ESTIMATE_REFERENCE_PRODUCT,
    photographedAngles: [args.angle],
    missingAnglesNeeded: [],
    imageQuality: { usableForMain: true, issues: [] },
  };
  const kept = args.output?.keepMediaIds.includes(args.mediaKey) === true;
  const plan = planShots(profile, {
    channels: [...args.channels],
    tier: args.tier,
    creditBudget: Number.MAX_SAFE_INTEGER,
    mediaIdsByAngle: { [args.angle]: args.mediaKey },
    // Nothing but the angle's own shots may use the new photo.
    primaryMediaId: `${args.mediaKey}#unused`,
    undeliverableMethods: [...undeliverableShotMethods],
    ...(args.output
      ? {
          output: planFlagsOf({ ...args.output, keepMediaIds: kept ? [args.mediaKey] : [] }, [
            {
              id: args.mediaKey,
              angle: args.angle,
              ...(args.photoSize ?? {}),
              ...(args.addedOverlays ? { addedOverlays: true } : {}),
            },
          ]),
        }
      : {}),
  });
  const fromPhoto = plan.shots.filter((s) => s.sourceMediaId === args.mediaKey);
  // A kept photo ships as itself first; its made white copy follows for the
  // channels that require white. A removed photo gets today's white shot.
  const picked = kept
    ? [fromPhoto.find((s) => s.type === "original_photo"), fromPhoto.find((s) => ANGLE_WHITE_TYPES.has(s.type))]
    : [fromPhoto.find((s) => ANGLE_WHITE_TYPES.has(s.type))];
  const out: Shot[] = [];
  for (const shot of picked) {
    if (!shot) {
      continue;
    }
    const channels = specsWithRoom(shot.channels, args.existingFilesBySpec);
    if (channels.length > 0) {
      // The first shot takes the skipped card's id; a second gets its own.
      out.push({ ...shot, id: out.length === 0 ? args.shotId : `${args.shotId}_${shot.type}`, channels });
    }
  }
  return out;
}

/**
 * The job's options for a follow up that adds a photo: on a Keep pack the
 * new photo is kept too, since the runner reads keepMediaIds as the list of
 * kept photos. Other packs are returned unchanged.
 */
export function withAddedPhoto(output: ResolvedOutputOptions, mediaKey: string): ResolvedOutputOptions {
  if (output.background !== "keep" || output.keepMediaIds.includes(mediaKey)) {
    return output;
  }
  return { ...output, keepMediaIds: [...output.keepMediaIds, mediaKey] };
}

/** What the board says after a cancel, from the credits it returned. */
export function cancelNotice(outcome: "canceled" | "stopped" | "finished", refundedCredits: number): string {
  const back =
    refundedCredits > 0
      ? `${formatCredits(refundedCredits)} ${refundedCredits === 1 ? "credit went" : "credits went"} back to your balance.`
      : "No credits were held for it.";
  switch (outcome) {
    case "canceled":
      return `This pack was canceled. ${back}`;
    case "stopped":
      return `We stopped the shots that were still running. ${back} Everything already delivered stays in your pack.`;
    case "finished":
      return "This pack had already finished, so there was nothing to cancel.";
  }
}

function formatCredits(credits: number): string {
  return Number.isInteger(credits) ? String(credits) : credits.toFixed(1);
}
