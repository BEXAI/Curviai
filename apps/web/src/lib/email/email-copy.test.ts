import { describe, expect, it } from "vitest";
import { fixedEmailCopy } from "@curvi/email";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { emailCopyTexts, MARKETING_CONSENT_LABEL, UNSUBSCRIBE_QUESTION } from "./copy";

// CLAUDE.md rule 9 and the claims guards (PHASE_18 principles 7 and 8) for
// the P18-06 copy: the consent box, the unsubscribe page, the settings
// toggle and the fixed email footer lines.

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

const ALL = [...emailCopyTexts, ...fixedEmailCopy];

describe("lifecycle email copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of ALL) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
      expect(text.trim()).toBe(text);
    }
  });

  it("claims no coming soon feature, no identical product and no credit expiry urgency", () => {
    for (const text of ALL) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
      expect(text).not.toMatch(/expir/i);
    }
  });

  it("says what the plan says", () => {
    expect(MARKETING_CONSENT_LABEL).toBe("Also send me tips on listing images and the occasional offer");
    expect(UNSUBSCRIBE_QUESTION).toBe(
      "Stop tips and offers from Curvi? You will still get emails about packs you make and payments.",
    );
  });
});
