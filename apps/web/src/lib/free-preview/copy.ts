/**
 * The free white main image before signup (docs/phases/PHASE_18.md P18-12):
 * the build flag and every string the feature shows. Client safe.
 *
 * NEXT_PUBLIC_FREE_PREVIEW=1 is the first of several gates: the founder sets
 * it only once fal is funded and Upstash is set (PHASE_18 founder step 18),
 * and the server still refuses until the database, storage, the cutout and
 * an LLM key are configured, the platform switch ops:free_preview_enabled is on,
 * packs are not paused and the day's caps have room.
 */

import { freePreview } from "@curvi/pipeline/seed";
import { typicalPackLines } from "@/lib/marketing-facts";

/** True when this build shows the free preview at all. Inlined at build. */
export function freePreviewOn(): boolean {
  return process.env.NEXT_PUBLIC_FREE_PREVIEW === "1";
}

/** Files a typical pack holds beyond the one main image the preview made. */
export function otherPackFiles(): number {
  const files = typicalPackLines()
    .filter((line) => line.comingSoon !== true)
    .reduce((total, line) => total + Number(/, (\d+)$/.exec(line.label)?.[1] ?? 1), 0);
  return Math.max(0, files - 1);
}

/** Two decimals, the way the report states a color difference. */
export function formatDeltaE(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export const FREE_PREVIEW_COPY = {
  boxTitle: "Try it on your own photo",
  box: "Drop one product photo. Get an Amazon ready white main image in about a minute. Free, no account.",
  pick: "Choose a photo",
  usePhoto: "Use a real cutout instead",
  handoff: "Make a free Amazon main image from this photo. This uploads your original photo to Curvi when you choose the button below.",
  working: "Cutting out your product and placing it on white. This takes about a minute.",
  limitReached: "That is today's free previews from this connection. Create a free account to keep going.",
  closed: "Free previews are paused right now. Create a free account to make a full pack.",
  dailyLimit: "That is all the free previews for today. Create a free account to keep going.",
  badRequest: "Choose one photo of your product, then try again.",
  emailInvalid: "Enter a valid email address.",
  expired: "This preview has expired. Make a new one, or create a free account.",
  blocked: "We cannot make a preview of this photo. Try a photo of a product you sell, on its own.",
  failed: "We could not make a clean cutout of this photo. Try a photo with the product in full view on a plain background.",
  unavailable: "Our image service is busy right now. Try again in a few minutes.",
  fullSizeTitle: "Get the full size file",
  fullSizeHelp: "Leave your email and the full size image downloads right away.",
  fullSizeButton: "Download full size",
  fullSizeNotice: "We keep your email to follow up about Curvi, and never sell it. Ask us to delete it any time.",
  signupButton: "Create a free account",
} as const;

/** The upload is over the seeded size cap. */
export function previewTooLargeLine(): string {
  return `That photo is larger than ${Math.round(freePreview.maxBytes / (1024 * 1024))} MB. Export a smaller file and try again.`;
}

/** After the email: how long the signed full size link lasts (seed). */
export function fullSizeReadyLine(): string {
  return `Your download has started. The link works for ${Math.round(freePreview.fullSizeLinkSeconds / 60)} minutes.`;
}

/** The result line for a preview whose checks passed. */
export function previewPassLine(meanDeltaE: number): string {
  return `Passes Amazon main image rules. Your product was cut out and placed on pure white, never redrawn: average color difference ${formatDeltaE(meanDeltaE)} inside the product.`;
}

/** The result line when a check did not pass (fill, size or background). */
export function previewCheckFailLine(meanDeltaE: number): string {
  return `Your product was cut out and placed on pure white, never redrawn: average color difference ${formatDeltaE(meanDeltaE)} inside the product. Some Amazon checks did not pass, listed below.`;
}

/** The signup offer under a result. */
export function previewNextStepLine(otherFiles: number = otherPackFiles()): string {
  return `Want the other ${otherFiles} files, sized for every channel? Create a free account and we will use this photo.`;
}

/** Plain names for the measured checks the result lists. */
export const PREVIEW_CHECK_LABELS: Record<string, string> = {
  dimensions: "Image size",
  longestSide: "Longest side",
  backgroundWhiteShare: "Pure white background",
  fillRatio: "Product fills the frame",
  bytes: "File size",
  format: "File type",
  megapixels: "Megapixels",
};
