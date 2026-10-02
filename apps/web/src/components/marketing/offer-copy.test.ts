import { describe, expect, it } from "vitest";
import { foundingMemberOffer, studioPriceComparison } from "@curvi/pipeline/seed";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { foundingBannerText, offerCopyTexts, perPackLine, studioComparisonLine } from "./offer-copy";

// CLAUDE.md rule 9 and the claims guard (PHASE_18 principles 7 and 8) for
// the offer copy (P18-21).
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

const view = {
  code: foundingMemberOffer.code,
  annualCode: foundingMemberOffer.annualCode,
  monthlyUsd: foundingMemberOffer.monthlyUsd,
  annualUsd: foundingMemberOffer.annualUsd,
  seats: foundingMemberOffer.seats,
  left: 7,
  endsOn: foundingMemberOffer.endsOn,
};

describe("offer copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of offerCopyTexts()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
      expect(text.trim()).toBe(text);
    }
  });

  it("claims no coming soon feature, no identity and no credit expiry urgency", () => {
    for (const text of offerCopyTexts()) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
      expect(text).not.toMatch(/expire/i);
    }
  });

  it("says what the plan says, with the seed's numbers", () => {
    const text = foundingBannerText(view);
    expect(text.title).toBe(
      `Founding member price: Starter at $${foundingMemberOffer.monthlyUsd} a month for as long as you stay.`,
    );
    expect(text.body).toBe(
      `7 of ${foundingMemberOffer.seats} seats left, until November 30. Use code ${foundingMemberOffer.code} at checkout.`,
    );
    expect(text.annual).toBe(
      `Paying yearly? Use code ${foundingMemberOffer.annualCode} for $${foundingMemberOffer.annualUsd} a year.`,
    );
    expect(foundingBannerText({ ...view, annualCode: null }).annual).toBeNull();
    expect(perPackLine(1.16)).toBe("About $1.16 per listing pack.");
  });

  it("dates and names the studio price from the seed", () => {
    expect(studioComparisonLine()).toBe(
      `For comparison, ${studioPriceComparison.studio}, a product photo studio, listed $${studioPriceComparison.usdPerPhoto} per photo on October 1, 2026.`,
    );
  });
});
