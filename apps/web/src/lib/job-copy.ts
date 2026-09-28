/**
 * Plain spoken copy for the progress board (CLAUDE.md rule 9). The worker
 * stores planner reasons, QC repair hints and failure messages written for
 * engineers, sometimes with provider names in them. Nothing from those
 * strings reaches the customer verbatim: each is matched to a short, honest
 * sentence here, and anything unknown falls back to a generic one. The raw
 * detail stays in the database and the server logs.
 */

import { isFeatureLive, shotMethodFeatures, type TierFeature } from "@curvi/pipeline/seed";

export interface SkippedCopy {
  /** Chip text on the card. */
  label: string;
  /** One or two sentences under the chip. */
  note: string;
}

const NO_CHARGE = "No credits were charged for it.";

const COMING_SOON: SkippedCopy = {
  label: "Coming soon",
  note: `We do not make this kind of shot yet. ${NO_CHARGE}`,
};

/**
 * The plan features that deliver each video shot type, mirroring the
 * planner's tier gates (packages/pipeline planner, rule 3): the hero loop is
 * generative video, the 15 second clip is lifestyle video and the UGC hook is
 * a UGC ad. The spin has no tier gate, so any video feature delivers it.
 * Whether a feature ships comes from the seed's featureStatus.
 */
const VIDEO_SHOT_FEATURES: Record<string, readonly TierFeature[]> = {
  video_spin: shotMethodFeatures.video_generate,
  video_hero_6s: ["generativeVideo"],
  video_lifestyle_15s: ["lifestyleVideo"],
  video_ugc_hook: shotMethodFeatures.avatar,
};

/** True for a video or avatar shot that no plan delivers today. */
function isComingSoonShot(shotType: string | null | undefined): boolean {
  const features = shotType ? VIDEO_SHOT_FEATURES[shotType] : undefined;
  return features !== undefined && !features.some((feature) => isFeatureLive(feature));
}

/**
 * Copy for a shot the planner left out, keyed on its stored reason. A video
 * or avatar shot that no plan delivers yet reads Coming soon whatever the
 * reason says: telling a seller a higher plan or another photo gets it
 * would promise output that does not ship (Phase 10 decision 1, rule 9).
 * "Not in your plan" stays for shots a higher plan really produces.
 */
export function skippedCopy(reason: string | null | undefined, shotType?: string | null): SkippedCopy {
  if (isComingSoonShot(shotType)) {
    return COMING_SOON;
  }
  const r = (reason ?? "").toLowerCase();
  if (r.includes("needs photo")) {
    return { label: "Needs photo", note: `Add a photo of this angle to get this shot. ${NO_CHARGE}` };
  }
  if (r.includes("plan tier") || r.includes("pro or agency")) {
    return { label: "Not in your plan", note: `This shot comes with a higher plan. ${NO_CHARGE}` };
  }
  if (r.includes("provider not enabled")) {
    return COMING_SOON;
  }
  if (r.includes("concept mode")) {
    return { label: "Skipped", note: "Concept packs leave out marketplace channels." };
  }
  if (r.includes("shot cap") || r.includes("credit budget")) {
    return { label: "Skipped", note: `The pack reached its size limit before this shot. ${NO_CHARGE}` };
  }
  if (r.includes("benefits")) {
    return {
      label: "Needs details",
      note: `Tell us a few product benefits in the notes to get this graphic. ${NO_CHARGE}`,
    };
  }
  if (r.includes("dimensions")) {
    return {
      label: "Needs details",
      note: `Add measurements you can confirm in the notes to get this shot. ${NO_CHARGE}`,
    };
  }
  if (r.includes("contents")) {
    return { label: "Needs details", note: `List what is in the box in the notes to get this shot. ${NO_CHARGE}` };
  }
  if (r.includes("comparison")) {
    return {
      label: "Needs details",
      note: `Add comparison facts you can back up in the notes to get this shot. ${NO_CHARGE}`,
    };
  }
  return { label: "Skipped", note: `This shot was left out of the pack. ${NO_CHARGE}` };
}

/** Why a shot ended in needs review, from its stored repair hint or
 * unavailable message. Always ends by saying it was not charged. */
export function needsReviewNote(hint: string | null | undefined): string {
  const h = (hint ?? "").toLowerCase();
  let reason = "It did not meet our quality bar, so we held it back.";
  if (
    h.includes("does not point at one of this product") ||
    h.includes("source photo") ||
    h.includes("no product was found") ||
    h.includes("found no product")
  ) {
    reason = "We could not find the product clearly in your photo. A sharp photo on a plain background usually fixes this.";
  } else if (h.includes("fix failed checks") || h.includes("productfidelity")) {
    reason = "It did not pass this channel's checks after several tries.";
  } else if (h.includes("spend cap") || h.includes("cost cap")) {
    reason = "It hit a safety limit on generation and was stopped. Try again later.";
  } else if (
    h.includes("not produced by live providers") ||
    h.includes("from the product photo alone yet") ||
    h.includes("not configured")
  ) {
    reason = "We do not make this kind of shot yet.";
  } else if (h.includes("seller details")) {
    reason = "It needs details from you, like what is in the box or confirmed measurements.";
  } else if (h.includes("stopped before this shot finished")) {
    reason = "The pack stopped before this shot finished.";
  } else if (
    h.includes("does not allow text") ||
    h.includes("plain background") ||
    h.includes("solid background") ||
    h.includes("laid out") ||
    h.includes("could not be rendered") ||
    h.includes("format and size") ||
    h.includes("larger than this channel allows") ||
    h.includes("nothing to show") ||
    h.includes("no channel to size")
  ) {
    reason = "It could not meet this channel's image rules.";
  }
  return `${reason} ${NO_CHARGE}`;
}

const GENERIC_FAILURE =
  "Something went wrong while making this pack. Credits held for it went back to your balance.";

/**
 * The failure line shown on a failed job. Known cases get their own honest
 * sentence; everything else, including provider errors, gets the generic
 * one so provider names and stack details never reach the page.
 */
export function publicJobError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return null;
  }
  const r = raw.toLowerCase();
  if (r.includes("interrupted before finishing")) {
    return "The run was interrupted before it finished. Credits held for it went back to your balance.";
  }
  if (r.includes("could not be queued") || r.includes("crashed before it could start")) {
    return "We could not start this pack. Credits held for it went back to your balance. Try again in a minute.";
  }
  if (r.includes("credit reservation failed") || r.includes("insufficient credit")) {
    return "There were not enough credits to start this pack. Top up or pick fewer channels.";
  }
  if (r.includes("already finished or failed elsewhere")) {
    return "This pack was stopped. Credits held for it went back to your balance.";
  }
  if (r.includes("cost cap") || r.includes("spend cap")) {
    return "This pack hit a safety limit on generation and was stopped. Credits held for it went back to your balance.";
  }
  return GENERIC_FAILURE;
}

export interface PackTally {
  delivered: number;
  needsReview: number;
  skipped: number;
  creditsCharged: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The done card's one line summary, e.g. "14 shots delivered. 2 need review,
 * no charge for those. 23 credits charged." */
export function packSummaryLine(tally: PackTally): string {
  const parts = [`${plural(tally.delivered, "shot", "shots")} delivered.`];
  if (tally.needsReview > 0) {
    parts.push(
      `${tally.needsReview} ${tally.needsReview === 1 ? "needs" : "need"} review, no charge for ${tally.needsReview === 1 ? "that one" : "those"}.`,
    );
  }
  if (tally.skipped > 0) {
    parts.push(`${plural(tally.skipped, "shot was", "shots were")} left out of the plan.`);
  }
  const credits = Number.isInteger(tally.creditsCharged) ? tally.creditsCharged : tally.creditsCharged.toFixed(1);
  parts.push(`${credits} ${tally.creditsCharged === 1 ? "credit" : "credits"} charged.`);
  return parts.join(" ");
}
