import { describe, expect, it } from "vitest";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { LEAD_SOURCES } from "@/lib/lead-sources";
import { acquisitionCopyTexts, SIGNUP_PAUSED_NOTICE, WAITLIST_CTA_LABEL, WAITLIST_NOTICE } from "./acquisition-copy";
import { WAITLIST_LEAD_SOURCE } from "@/lib/acquisition-client";

// CLAUDE.md rule 9 and the claims guard (PHASE_18 principles 7 and 8) for
// the acquisition gate's copy (P18-03).
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

describe("acquisition gate copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of acquisitionCopyTexts) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
      expect(text.trim()).toBe(text);
    }
  });

  it("claims no coming soon feature and no credit expiry urgency", () => {
    for (const text of acquisitionCopyTexts) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
      expect(text).not.toMatch(/expire/i);
    }
  });

  it("says what the plan says", () => {
    expect(WAITLIST_CTA_LABEL).toBe("Get notified when packs are back");
    expect(WAITLIST_NOTICE).toBe(
      "Packs are paused for a short while. Leave your email and we will tell you the moment they are back. The free checkers still work.",
    );
    expect(SIGNUP_PAUSED_NOTICE).toBe(
      "Packs are paused right now. You can create your account today, and we will email you when packs are back.",
    );
  });

  it("stores waitlist emails under the seeded packs-paused lead source", () => {
    expect(WAITLIST_LEAD_SOURCE).toBe("packs-paused");
    expect(LEAD_SOURCES).toContain(WAITLIST_LEAD_SOURCE);
  });
});
