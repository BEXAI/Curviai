/**
 * Phrases in the seller's note that mean "keep my background" (PHASE_15 P1,
 * the "Keep my background" hint). The new pack form matches them against
 * the note, lower case, and offers to turn off Remove the background. Seed
 * data per CLAUDE.md rule 2, so the list grows without a code change. The
 * note itself is never parsed for options: the hint only asks.
 */
export const keepBackgroundPhrases = [
  "keep the background",
  "keep my background",
  "keep background",
  "keep the original background",
  "keep the backdrop",
  "keep my backdrop",
  "keep the setting",
  "keep my photo as is",
  "keep the photo as is",
  "keep the photos as they are",
  "leave the background",
  "don't remove the background",
  "dont remove the background",
  "do not remove the background",
  "no background removal",
  "without removing the background",
  "same background",
  "original background",
] as const;
