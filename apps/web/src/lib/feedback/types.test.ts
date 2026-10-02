import { describe, expect, it } from "vitest";
import { packFeedback } from "@curvi/pipeline/seed";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { allFeedbackCopy, FEEDBACK_COPY } from "./copy";
import { validateFeedbackAnswer } from "./types";

// P18-05: the one validator every caller shares, and the copy lint
// (CLAUDE.md rule 9 and the claims guards).

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

describe("validateFeedbackAnswer", () => {
  it("takes the three usable answers and the optional rest", () => {
    for (const usable of ["yes", "some", "not_yet"]) {
      const result = validateFeedbackAnswer({ usable });
      expect(result).toEqual({
        ok: true,
        answer: { usable, wouldPay: null, comment: null, quoteConsent: false, displayName: null },
      });
    }
    expect(validateFeedbackAnswer({ usable: "yes", wouldPay: "no", comment: "  Brighter scenes.  " })).toMatchObject({
      ok: true,
      answer: { wouldPay: "no", comment: "Brighter scenes." },
    });
  });

  it("refuses unknown answers and other shapes", () => {
    expect(validateFeedbackAnswer({ usable: "maybe" })).toEqual({ ok: false, message: FEEDBACK_COPY.pickUsable });
    expect(validateFeedbackAnswer({})).toEqual({ ok: false, message: FEEDBACK_COPY.pickUsable });
    expect(validateFeedbackAnswer(null)).toEqual({ ok: false, message: FEEDBACK_COPY.pickUsable });
    expect(validateFeedbackAnswer(["yes"])).toEqual({ ok: false, message: FEEDBACK_COPY.pickUsable });
    expect(validateFeedbackAnswer({ usable: "yes", wouldPay: "sure" })).toEqual({ ok: false, message: FEEDBACK_COPY.invalid });
  });

  it("holds the seeded text caps", () => {
    const long = "a".repeat(packFeedback.commentMaxChars + 1);
    expect(validateFeedbackAnswer({ usable: "yes", comment: long })).toEqual({
      ok: false,
      message: FEEDBACK_COPY.commentTooLong,
    });
    expect(
      validateFeedbackAnswer({ usable: "yes", comment: "a".repeat(packFeedback.commentMaxChars) }),
    ).toMatchObject({ ok: true });
    expect(
      validateFeedbackAnswer({
        usable: "yes",
        comment: "Great",
        quoteConsent: true,
        displayName: "n".repeat(packFeedback.displayNameMaxChars + 1),
      }),
    ).toEqual({ ok: false, message: FEEDBACK_COPY.nameTooLong });
  });

  it("needs words to quote and keeps the name only with consent", () => {
    expect(validateFeedbackAnswer({ usable: "yes", quoteConsent: true, displayName: "Ana" })).toEqual({
      ok: false,
      message: FEEDBACK_COPY.quoteNeedsWords,
    });
    expect(validateFeedbackAnswer({ usable: "yes", comment: "Nice", displayName: "Ana" })).toMatchObject({
      answer: { quoteConsent: false, displayName: null },
    });
    expect(
      validateFeedbackAnswer({ usable: "yes", comment: "Nice", quoteConsent: true, displayName: " Ana,\n Juniper " }),
    ).toMatchObject({ answer: { quoteConsent: true, displayName: "Ana, Juniper" } });
    expect(
      validateFeedbackAnswer({ usable: "yes", comment: "Nice", quoteConsent: true, displayName: "ana@shop.com" }),
    ).toEqual({ ok: false, message: FEEDBACK_COPY.nameNotEmail });
  });

  it("treats a consent that is not exactly true as no consent", () => {
    expect(validateFeedbackAnswer({ usable: "yes", comment: "Nice", quoteConsent: "true", displayName: "Ana" })).toMatchObject(
      { answer: { quoteConsent: false, displayName: null } },
    );
  });
});

describe("feedback copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of allFeedbackCopy()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
    }
  });

  it("claims no coming soon feature and no byte identity", () => {
    for (const text of allFeedbackCopy()) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
    }
  });
});
