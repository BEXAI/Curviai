import { describe, expect, it } from "vitest";
import { freePreview, sellerCategories } from "@curvi/pipeline/seed";
import { EXAMPLE_PACK_COPY, EXAMPLE_PACK_FILES } from "@/components/app/example-pack";
import {
  FREE_PREVIEW_COPY,
  fullSizeReadyLine,
  otherPackFiles,
  PREVIEW_CHECK_LABELS,
  previewCheckFailLine,
  previewNextStepLine,
  previewPassLine,
  previewTooLargeLine,
} from "@/lib/free-preview/copy";
import { GOOGLE_SIGN_IN_LABEL } from "@/lib/google-sign-in";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { AUTH_ERROR_MESSAGES } from "@/lib/safe-next";
import { WELCOME_QUESTIONS_COPY } from "./welcome-questions";

// Copy lint for Lane 8 Activation (docs/phases/PHASE_18.md principle 7,
// CLAUDE.md rule 9): every string Google sign in, the first run questions
// and the example pack show is plain spoken, with no emojis, no arrows and
// no dashes used as punctuation, and claims no coming soon feature.

const PUNCTUATION_DASH_OR_ARROW = /[–—→←⇒]| - |->|<-|=>/;
const EMOJI = /\p{Extended_Pictographic}/u;

function activationStrings(): Array<[string, string]> {
  return [
    ["google label", GOOGLE_SIGN_IN_LABEL],
    ["oauth_failed", AUTH_ERROR_MESSAGES.oauth_failed],
    ...Object.entries(WELCOME_QUESTIONS_COPY).map(([key, text]): [string, string] => [`welcome ${key}`, text]),
    ...Object.entries(EXAMPLE_PACK_COPY).map(([key, text]): [string, string] => [`example ${key}`, text]),
    ...EXAMPLE_PACK_FILES.flatMap((file): Array<[string, string]> => [
      [`example caption ${file.src}`, file.caption],
      [`example alt ${file.src}`, file.alt],
    ]),
    ...sellerCategories.map((category): [string, string] => [`category ${category.key}`, category.label]),
    ...Object.entries(FREE_PREVIEW_COPY).map(([key, text]): [string, string] => [`preview ${key}`, text]),
    ...Object.entries(PREVIEW_CHECK_LABELS).map(([key, text]): [string, string] => [`preview check ${key}`, text]),
    ["preview pass", previewPassLine(0.4237)],
    ["preview check fail", previewCheckFailLine(1.5)],
    ["preview next step", previewNextStepLine()],
    ["preview too large", previewTooLargeLine()],
    ["preview full size ready", fullSizeReadyLine()],
  ];
}

describe("free preview copy (P18-12)", () => {
  it("states the measured color difference and the seeded numbers", () => {
    expect(previewPassLine(0.4237)).toBe(
      "Passes Amazon main image rules. Your product was cut out and placed on pure white, never redrawn: average color difference 0.42 inside the product.",
    );
    expect(otherPackFiles()).toBeGreaterThan(0);
    expect(previewNextStepLine(9)).toBe(
      "Want the other 9 files, sized for every channel? Create a free account and we will use this photo.",
    );
    expect(previewTooLargeLine()).toContain(`${Math.round(freePreview.maxBytes / (1024 * 1024))} MB`);
    expect(fullSizeReadyLine()).toContain(`${Math.round(freePreview.fullSizeLinkSeconds / 60)} minutes`);
    expect(FREE_PREVIEW_COPY.box).toBe(
      "Drop one product photo. Get an Amazon ready white main image in about a minute. Free, no account.",
    );
    expect(FREE_PREVIEW_COPY.limitReached).toBe(
      "That is today's free previews from this connection. Create a free account to keep going.",
    );
  });
});

describe("activation copy", () => {
  it("has no emojis, arrows or dashes as punctuation", () => {
    for (const [name, text] of activationStrings()) {
      expect(text, name).not.toMatch(PUNCTUATION_DASH_OR_ARROW);
      expect(text, name).not.toMatch(EMOJI);
      expect(text.trim(), name).toBe(text);
    }
  });

  it("claims no coming soon feature and no product identity (P18-09)", () => {
    for (const [name, text] of activationStrings()) {
      expect(unqualifiedClaims(text), name).toEqual([]);
      expect(identityClaims(text), name).toEqual([]);
    }
  });
});
