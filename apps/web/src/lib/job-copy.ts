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
  if (r.includes("channel image limit")) {
    // The planner's CHANNEL_LIMIT_REASON (packages/pipeline planner).
    return {
      label: "Skipped",
      note: `This channel already has as many images as it allows, so this shot was left out. ${NO_CHARGE}`,
    };
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
    return {
      label: "Needs details",
      note: `List what is in the box under Details for more images on your next pack to get this shot. ${NO_CHARGE}`,
    };
  }
  if (r.includes("comparison")) {
    return {
      label: "Needs details",
      note: `Add comparison facts you can back up under Details for more images on your next pack to get this shot. ${NO_CHARGE}`,
    };
  }
  return { label: "Skipped", note: `This shot was left out of the pack. ${NO_CHARGE}` };
}

/** A generative shot left out while the scene image service was down
 * (Phase 14 1.3). */
export const SCENE_PAUSED_NOTE = "Paused, the scene service is unavailable, so this scene was left out of the pack.";

/**
 * Why a shot ended in needs review, from its stored repair hint or
 * unavailable message. Always ends by saying it was not charged. The runner's
 * own plain hints (trigger/src pipeline-runner.ts and live-runtime.ts) are
 * matched first, since several of them are not a quality problem at all: a
 * shot left out over a channel's image limit passed every check.
 */
export function needsReviewNote(hint: string | null | undefined): string {
  const h = (hint ?? "").toLowerCase();
  let reason = "It did not meet our quality bar, so we held it back.";
  if (h.includes("as many images as it allows")) {
    // SHOT_CHANNEL_FULL: passed QC, dropped by the packager over the limit.
    reason = "It passed our checks, but this channel already has as many images as it allows, so it was left out of the pack.";
  } else if (h.includes("could not be added to the pack")) {
    // SHOT_NOT_DELIVERED: passed QC, but the packager could not deliver it.
    reason = "It passed our checks, but we could not add it to the pack, so it was left out.";
  } else if (h.includes("declined to make this scene")) {
    // SHOT_CONTENT_BLOCKED: the image provider's safety system said no.
    reason = "The image service declined to make this scene, so we held this shot back.";
  } else if (h.includes("in the wrong shape")) {
    // HARMONIZE_SHAPE_REFUSED: the lighting pass came back at another size,
    // so the real product could not be placed back exactly.
    reason =
      "The image service returned this scene in the wrong shape, so your product could not be placed back exactly and we held it back.";
  } else if (h.includes("spending limit")) {
    // The runner's pack spend cap, reached before this shot ran.
    reason = "The pack reached its spending limit before this shot could be made.";
  } else if (h.includes("scene service is unavailable")) {
    // pipeline-runner.ts SHOT_SCENE_PAUSED (Phase 14 1.3).
    reason = SCENE_PAUSED_NOTE;
  } else if (h.includes("provider had trouble")) {
    // SHOT_PROVIDER_TROUBLE: an unexpected provider or runtime error.
    reason = "The image service had trouble with this shot, so we held it back.";
  } else if (h.includes("could not check this shot")) {
    reason = "We could not run our checks on this shot, so we held it back.";
  } else if (h.includes("screenshot") || h.includes("screen capture")) {
    reason = "This photo looks like a screenshot, not a photo of your product. Take a photo of the product with your camera.";
  } else if (h.includes("touches another product")) {
    // live-runtime.ts PRODUCT_TOUCHING: the picked product touches another
    // one, so the cutout could not keep only it.
    reason =
      "The product you picked touches another product in your photo, so we could not separate them. Take a photo with only that product and start a new pack.";
  } else if (h.includes("more than one product")) {
    // pipeline-runner.ts SHOT_EXTRA_ITEMS: the image still held a second
    // product after the others were removed.
    reason = "This image still showed another product next to the one you picked, so we held it back.";
  } else if (h.includes("separate the product from its background")) {
    // live-runtime.ts SEGMENTATION_FAILED: the cutout kept the background.
    reason =
      "We could not separate the product from the background in your photo. A sharp photo on a plain background usually fixes this.";
  } else if (
    h.includes("does not point at one of this product") ||
    h.includes("source photo") ||
    h.includes("no product was found") ||
    h.includes("found no product") ||
    h.includes("no product to place") ||
    h.includes("find the product you picked")
  ) {
    reason = "We could not find the product clearly in your photo. A sharp photo on a plain background usually fixes this.";
  } else if (h.includes("would be cut off")) {
    // shot-outputs.ts: the product does not fit this channel's shape.
    reason = "Your product would be cut off at this channel's shape, so we held this image back.";
  } else if (h.includes("could not be prepared for")) {
    reason = "We could not prepare this image for this channel, so we held it back.";
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

const HELD_RETURNED = "Credits held for it went back to your balance.";
const HELD_RUN_AGAIN = "Credits held for it went back to your balance, so you can run it again.";
const NOTHING_CHARGED = "Nothing was charged.";
const CONTACT = "email hello@curvi.ai";
const WRONG_CALL = "If your product is something else, use a different photo that shows only the product and start a new pack.";
/** Photo guidance for a refused photo (PHASE_14 item 3.3). */
const PHOTO_TIPS =
  "For the best result, photograph one product on a plain background, with the whole product in the frame. A note that names the product, like the silver watch, also helps us find it. Then start a new pack.";

/**
 * Seller copy for every failure a pack can end on, by what the seller can do
 * about it. Each line says what happened, that nothing was charged (a failed
 * pack is never charged: the runner releases its whole hold) and what to do
 * next. docs/phases/PHASE_12.md "A6 failure copy inventory" lists the stored
 * message behind each one.
 */
export const JOB_ERROR_COPY = {
  // The photo cannot be used.
  screenshot: `This photo looks like a screenshot, not a photo of your product. Take a photo of the product with your camera and start a new pack. ${NOTHING_CHARGED}`,
  multipleProducts: `We found more than one product in this photo and could not tell which one you meant. Start a new pack and say which product to feature, or use a photo with only that product. ${NOTHING_CHARGED}`,
  noProduct: `We could not find a product to sell in your photos. ${PHOTO_TIPS} ${NOTHING_CHARGED}`,
  cutout: `We could not separate the product from the background in your photo. Take a sharp photo of the product on a plain background, then start a new pack. ${NOTHING_CHARGED}`,
  noShotPassed: `None of the shots in this pack passed our quality checks, so nothing was charged. Each shot below says why. A sharp photo of the product on a plain background often helps.`,
  // Content blocked.
  // Content Curvi never makes, whatever the brand (docs/phases/PHASE_14.md
  // workstream 2). There is no review queue, so each line names the
  // category and says what to do now. Brands and logos never land here.
  blockedAdult: `Curvi does not make images of nudity or adult content, so we did not make a pack from this photo. ${NOTHING_CHARGED} ${WRONG_CALL}`,
  blockedWeapons: `Curvi does not make images of weapons, so we did not make a pack from this photo. ${NOTHING_CHARGED} ${WRONG_CALL}`,
  blockedDrugs: `Curvi does not make images of drugs, so we did not make a pack from this photo. ${NOTHING_CHARGED} ${WRONG_CALL}`,
  blockedProhibited: `Curvi does not make images of goods that are banned from sale or recalled, so we did not make a pack from this photo. ${NOTHING_CHARGED} ${WRONG_CALL}`,
  blockedPerson: `This photo shows a person as the main subject, and Curvi makes images of products. ${NOTHING_CHARGED} Use a photo where the product is the main subject and start a new pack. A product worn on a wrist or held in a hand is fine.`,
  flagged: `We could not make a pack from this photo because of what it shows. ${NOTHING_CHARGED} ${WRONG_CALL}`,
  contentBlocked: `The image service would not make images from this photo under its content rules, so this pack stopped. ${NOTHING_CHARGED} Try a different photo of the product.`,
  // Limits and credits.
  credits: `There were not enough credits to start this pack. ${NOTHING_CHARGED} Top up or pick fewer channels.`,
  packCap: `This pack hit a safety limit on generation and was stopped. ${HELD_RETURNED} Try again with fewer channels.`,
  workspaceDayCap: `Your workspace reached its daily limit for making images, so this pack stopped. ${NOTHING_CHARGED} Try again tomorrow, or ${CONTACT} to raise the limit.`,
  globalDayCap: `We reached our daily safety limit for making images, so this pack stopped. ${NOTHING_CHARGED} Try again tomorrow.`,
  noShotsPlanned: `We could not plan any shots for the channels you picked, so nothing was charged. Try other channels, or ${CONTACT} if it keeps happening.`,
  // Our side.
  interrupted: `The run was interrupted before it finished. ${HELD_RETURNED}`,
  notStarted: `Our server restarted before this pack could start. ${HELD_RUN_AGAIN}`,
  restarted: `Our server restarted while this pack was running. ${HELD_RUN_AGAIN}`,
  timedOut: `This pack took longer than our time limit, so we stopped it. ${HELD_RUN_AGAIN}`,
  internal: `This pack stopped because of an error on our side. ${HELD_RUN_AGAIN}`,
  notQueued: `We could not start this pack. ${HELD_RETURNED} Try again in a minute.`,
  stopped: `This pack was stopped. ${HELD_RETURNED}`,
  planFailed: `We could not plan the shots for this product, so nothing was charged. Try again, or contact us if it keeps happening.`,
  readFailed: `We could not read your product from the photos because of a problem on our side. ${NOTHING_CHARGED} Try again in a few minutes.`,
  setup: `This pack stopped because of a problem on our side, not with your photo. ${NOTHING_CHARGED} Try again later, and ${CONTACT} if it keeps happening.`,
  serviceBusy: `A service we use to make images is busy or not responding, so this pack stopped. ${NOTHING_CHARGED} Try again in a few minutes.`,
  noShotsMade: `None of the shots in this pack could be made because of a problem on our side. ${NOTHING_CHARGED} Try again in a few minutes.`,
  notDelivered: `Your shots were made, but we could not put them into a pack because of a problem on our side. ${NOTHING_CHARGED} Try again in a few minutes.`,
  generic: `Something went wrong while making this pack. ${HELD_RETURNED}`,
} as const;

export type JobErrorKind = keyof typeof JOB_ERROR_COPY;

type Rule = readonly [JobErrorKind, (r: string) => boolean];

const has =
  (...needles: string[]) =>
  (r: string): boolean =>
    needles.some((n) => r.includes(n));

/** A provider HTTP status the adapters format as "<provider> responded
 * <status>: <body>" (packages/ai adapters shared.ts, photoroomCutout.ts). */
function respondedStatus(r: string): number | null {
  const match = /responded (\d{3})/.exec(r) ?? /failed with status (\d{3})/.exec(r);
  return match ? Number(match[1]) : null;
}

/** A 4xx that is not a timeout or rate limit: our request, key or account
 * was wrong (a bad API key answers 401), never the seller's photo. */
function isSetupStatus(r: string): boolean {
  const status = respondedStatus(r);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isBusyStatus(r: string): boolean {
  const status = respondedStatus(r);
  return status !== null && (status >= 500 || status === 408 || status === 429);
}

/** pipeline-runner.ts MODERATION_BLOCKED_PREFIX, and the "flagged for"
 * wording older jobs stored. */
function isModeration(r: string): boolean {
  return r.startsWith("moderation stopped this pack") || r.includes("flagged for") || r.includes("manual review");
}

/** pipeline-runner.ts NO_SELLABLE_PRODUCT_MESSAGE, lowercased. */
const NO_PRODUCT_START = "intake found no sellable product";

/**
 * Ordered: the first match wins. Our own plain messages come first, then
 * photo and content problems, limits, and last the provider and runtime
 * failures, whose raw text can name anything.
 */
const RULES: readonly Rule[] = [
  // The runner's no product message carries intake's labels, which are
  // model text, so it is matched on its fixed start before anything else.
  ["noProduct", (r) => r.startsWith(NO_PRODUCT_START)],
  ["screenshot", has("screenshot", "screen capture")],
  // pipeline-runner.ts MULTIPLE_PRODUCTS_MESSAGE: several products and no
  // single match to the seller's note.
  ["multipleProducts", has("more than one product")],
  // The web app's own settle and reconcile messages (lib/jobs/enqueue.ts
  // SETTLED_JOB_MESSAGES, services/reconcile.ts, services/db.ts abandonJob).
  ["interrupted", has("interrupted before finishing")],
  ["notStarted", has("server restarted before this pack could start")],
  ["restarted", has("server restarted while this pack was running")],
  ["timedOut", has("longer than the time limit")],
  ["internal", has("stopped because of an internal error")],
  ["notQueued", has("could not be queued", "crashed before it could start")],
  // Our own credit functions (services/db.ts ReservationError, the
  // reserve_credits SQL exception). A provider's own "Insufficient credits"
  // answer is our account, so it is left to the setup rule below.
  ["credits", has("credit reservation failed", "insufficient credit balance")],
  // Intake and analysis gates (trigger/src/pipeline-runner.ts). Older jobs
  // stored "flagged for ... manual review"; they map to the same lines.
  ["blockedAdult", (r) => isModeration(r) && (r.includes("nudity") || r.includes("adult"))],
  ["blockedWeapons", (r) => isModeration(r) && r.includes("weapon")],
  ["blockedDrugs", (r) => isModeration(r) && r.includes("drugs")],
  ["blockedProhibited", (r) => isModeration(r) && r.includes("prohibited")],
  ["blockedPerson", (r) => isModeration(r) && r.includes("main subject")],
  ["flagged", isModeration],
  ["noProduct", has("no sellable product", "found no product", "no product was found", "no product to place")],
  ["cutout", has("separate the product from its background")],
  ["readFailed", has("failed schema validation")],
  ["planFailed", has("could not plan the shots")],
  ["noShotsPlanned", has("no shots could be planned")],
  ["noShotPassed", has("passed its checks")],
  ["notDelivered", has("could be delivered", "could not be delivered", "storage is not configured")],
  // Spend caps (packages/ai caps.ts keys, router.ts "Spend cap blocked call").
  ["setup", has("reservation could not be made", "counter could not be updated")],
  ["workspaceDayCap", has("caps:workspace:")],
  ["globalDayCap", has("caps:global:")],
  ["packCap", has("cost cap", "spend cap", "spending limit")],
  // Provider safety refusals (content_blocked in packages/ai adapters).
  [
    "contentBlocked",
    has("content_blocked", "declined", "blocked the prompt", "stop_reason refusal", "moderat", "safety system"),
  ],
  // Our configuration, keys and accounts.
  [
    "setup",
    (r) =>
      isSetupStatus(r) ||
      [
        "api key",
        "api_key",
        "x-api-key",
        "authentication",
        "unauthorized",
        "forbidden",
        "permission",
        "not registered",
        "does not support task",
        "no providers routed",
        "estimatecostmicros",
        "cost estimate",
        "price table",
        "maxcostmicros",
        "no active recipe",
        "not configured",
      ].some((n) => r.includes(n)),
  ],
  // Runner bookkeeping that should never happen (trigger/src/state.ts).
  [
    "internal",
    has("illegal transition", "credits were already reserved", "reserve amount must be", "before reserving", "of the reservation is outstanding"),
  ],
  // Outages: timeouts, 5xx, rate limits, open breakers, empty answers.
  [
    "serviceBusy",
    (r) =>
      isBusyStatus(r) ||
      [
        "timed out",
        "timeout",
        "network error",
        "circuit breaker",
        "rate limit",
        "overloaded",
        "fetch failed",
        "econn",
        "all providers failed",
      ].some((n) => r.includes(n)),
  ],
  ["noShotsMade", has("none of the shots in this pack could be made")],
  ["stopped", has("already finished or failed elsewhere")],
];

/** Which seller facing case a stored job error falls in, or null for none. */
export function jobErrorKind(raw: string | null | undefined): JobErrorKind | null {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return null;
  }
  const r = raw.toLowerCase();
  for (const [kind, test] of RULES) {
    if (test(r)) {
      return kind;
    }
  }
  return "generic";
}

/**
 * The failure line shown on a failed job. Every message the runner and the
 * web app store gets its own honest sentence: what happened, that nothing
 * was charged and what to do next. Anything unknown gets the generic one.
 * The output is always one of JOB_ERROR_COPY, so provider names, HTTP
 * statuses and response bodies never reach the page; the raw detail stays in
 * the database and the server logs.
 */
export function publicJobError(raw: string | null | undefined): string | null {
  const kind = jobErrorKind(raw);
  if (kind === "noProduct") {
    return noProductCopy(raw ?? "");
  }
  return kind === null ? null : JOB_ERROR_COPY[kind];
}

/** A label from intake reduced to plain words: letters, spaces and
 * apostrophes only, so no digits, brackets or symbols reach the page. */
function plainLabel(label: string): string {
  return label
    .replace(/[^A-Za-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 40)
    .trim();
}

/** Words that never belong in a product label on the page: service names
 * and engineering terms. A label with one is dropped, not shown. */
const NOT_A_LABEL =
  /anthropic|claude|gemini|google|openai|gpt|photoroom|\bbfl\b|flux|\bfal\b|replicate|responded|status|schema|provider|micros|circuit|breaker|stop_reason|json|error/;

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function splitFirstSentence(text: string): [string, string] {
  const end = text.indexOf(". ");
  return end < 0 ? [text, ""] : [text.slice(0, end + 1), text.slice(end + 2)];
}

/**
 * The no product line (PHASE_14 item 3.3). When the runner stored what
 * intake saw (pipeline-runner.ts noSellableProductMessage: "Intake saw: a;
 * b" and "Not sharp"), the line says so before the photo tips. Model text
 * is reduced to plain words first; the rest is JOB_ERROR_COPY.noProduct.
 */
export function noProductCopy(raw: string): string {
  const base = JOB_ERROR_COPY.noProduct;
  const [lead, rest] = splitFirstSentence(base);
  const extra: string[] = [];
  const marker = "intake saw:";
  const sawAt = raw.toLowerCase().indexOf(marker);
  if (sawAt >= 0) {
    const labels = [
      ...new Set(
        raw
          .slice(sawAt + marker.length)
          .split(";")
          .map(plainLabel)
          .filter((label) => label.length > 1 && !NOT_A_LABEL.test(label)),
      ),
    ].slice(0, 3);
    if (labels.length > 0) {
      extra.push(`We saw ${listWords(labels)}, but could not tell that any of it is a product for sale.`);
    }
  }
  if (/\. not sharp/i.test(raw)) {
    extra.push("The photo also looked blurry.");
  }
  return extra.length === 0 ? base : [lead, ...extra, rest].join(" ");
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
