import { describe, expect, it } from "vitest";
import { prospectClaims } from "@curvi/pipeline/seed";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import {
  CLAIM_COPY,
  claimCtaText,
  draftEmail,
  draftNote,
  fidelityLine,
  outreachSignature,
  PROSPECT_PAGE_COPY,
  prospectShareTitle,
  wordCount,
} from "./copy";

// P18-04 copy: CLAUDE.md rule 9 (no emojis, arrows or dashes as
// punctuation), the claims guards, and the draft note under the seeded word
// limit with the plan's measured values.

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const LINK = "https://curvi.ai/s/abcd2345ef?claim=0123456789abcdef0123456789abcdef01234567";

function allCopy(): string[] {
  return [
    ...strings(CLAIM_COPY),
    ...strings(PROSPECT_PAGE_COPY),
    PROSPECT_PAGE_COPY.creditsLine(120, 340),
    PROSPECT_PAGE_COPY.creditsAdded(40),
    PROSPECT_PAGE_COPY.creditsOverCap(80),
    PROSPECT_PAGE_COPY.creditsOverCap(0),
    PROSPECT_PAGE_COPY.importFailed("We could not read that link."),
    prospectShareTitle("Juniper Candles"),
    claimCtaText("Juniper Candles"),
    fidelityLine({ measuredFiles: 7, deliveredFiles: 8, highestMeanDeltaE: 0.84, allWithinLimits: true }),
    fidelityLine({ measuredFiles: 0, deliveredFiles: 8, highestMeanDeltaE: null, allWithinLimits: true }),
    draftNote({ name: "Ana", product: "lavender candle", whitePercent: 62.34, fillPercent: 71, link: LINK, founder: "Nathaniel" }),
    draftNote({ name: "", product: "", whitePercent: null, fillPercent: null, link: LINK, founder: "" }),
    outreachSignature("Nathaniel"),
    outreachSignature(""),
    draftEmail({ name: "Ana", product: "lavender candle", whitePercent: 62.34, fillPercent: 71, link: LINK, founder: "Nathaniel" }),
  ];
}

describe("prospect copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of allCopy()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
    }
  });

  it("claims no coming soon feature and no byte identity", () => {
    for (const text of allCopy()) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
    }
  });

  it("uses the plan's claim and title wording", () => {
    expect(prospectShareTitle("Juniper Candles")).toBe("Juniper Candles listing pack, made by Curvi");
    expect(claimCtaText("Juniper Candles")).toBe(
      "This pack was made for Juniper Candles from your current listing photo. Make it yours: create a free account and your product is ready to go.",
    );
    expect(`${CLAIM_COPY.footerQuestion} ${CLAIM_COPY.takedownLink}, ${CLAIM_COPY.footerEmail}`).toBe(
      "Not yours, or want this page removed? Take it down here, or email support@curvi.ai.",
    );
  });
});

describe("draft note", () => {
  it("quotes the measured values and the link, under the seeded word limit", () => {
    const note = draftNote({
      name: "Ana",
      product: "lavender soy candle 8 oz",
      whitePercent: 62.34,
      fillPercent: 71.06,
      link: LINK,
      founder: "Nathaniel, Curvi",
    });
    expect(note).toContain("Hi Ana, I ran your lavender soy candle 8 oz main image through our Amazon checker.");
    expect(note).toContain("The background measures 62.3 percent pure white and the product fills 71.1 percent of the frame.");
    expect(note).toContain(`without redrawing your product: ${LINK}.`);
    expect(note).toContain("If it is useful, I can do your next three products.");
    expect(note.endsWith("Nathaniel, Curvi")).toBe(true);
    expect(wordCount(note)).toBeLessThanOrEqual(prospectClaims.draftNoteMaxWords);
  });

  it("sends the note with the outreach signature CAN-SPAM asks for, and says where to send it from", () => {
    const email = draftEmail({ name: "Ana", product: "candle", whitePercent: null, fillPercent: null, link: LINK, founder: "Nathaniel" });
    const [note, signature] = email.split("\n\n");
    expect(wordCount(note)).toBeLessThanOrEqual(prospectClaims.draftNoteMaxWords);
    expect(signature).toBe(outreachSignature("Nathaniel"));
    expect(signature.split("\n")).toEqual([
      "Nathaniel",
      "Founder, Curvi",
      "https://curvi.ai",
      "[Postal address]",
      "This is a promotional email from Curvi.",
      'If you would rather not hear from me, reply "no thanks" and I will not write again.',
    ]);
    expect(outreachSignature("  ").startsWith("[Your first name]\n")).toBe(true);
    expect(PROSPECT_PAGE_COPY.kitNoteHint).toContain("outreach domain");
    expect(PROSPECT_PAGE_COPY.kitNoteHint).toContain("do not contact list");
    expect(PROSPECT_PAGE_COPY.kitNoteHint).not.toContain("your own inbox");
  });

  it("leaves the checker sentence out when nothing was measured", () => {
    const note = draftNote({ name: "", product: "", whitePercent: null, fillPercent: null, link: LINK, founder: "" });
    expect(note).toBe(
      `Hi there, I made a full listing pack from the same photo, free, without redrawing your product: ${LINK}. If it is useful, I can do your next three products.`,
    );
  });
});
