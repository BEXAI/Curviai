import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import {
  annualReminderSentence,
  countOf,
  entitySentence,
  governingLawSentence,
  isPending,
  legalDate,
  numberWord,
  pendingLegalFacts,
  replySentence,
  supportReplyTime,
  termsChangeSentence,
  type LegalLine,
} from "./copy";
import { LEGAL_FACTS, type LegalFacts } from "./facts";

// docs/phases/PHASE_20.md P20-23: the sentences the legal pages share.

const SET: LegalFacts = {
  ...LEGAL_FACTS,
  entity: {
    name: "Curvi Example LLC",
    postalAddress: "1 Example Street, Springfield, IL 62701, United States",
    governingLaw: "the State of Illinois, United States",
  },
  support: { email: "help@example.com", replyBusinessDays: 3 },
  annualRenewalReminderDays: [30, 45],
  termsChangeNoticeDays: 14,
};

function text(line: LegalLine): string {
  return isPending(line) ? line.pending : line;
}

describe("number and date helpers", () => {
  it("spells small numbers and pluralizes units", () => {
    expect(numberWord(2)).toBe("two");
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(12)).toBe("12");
    expect(countOf(1, "day")).toBe("1 day");
    expect(countOf(30, "day")).toBe("30 days");
    expect(countOf(3, "year")).toBe("3 years");
  });

  it("prints a calendar day the way the pages show it, in any time zone", () => {
    expect(legalDate("2026-10-01")).toBe("October 1, 2026");
    expect(legalDate("2026-09-28")).toBe("September 28, 2026");
  });
});

describe("support", () => {
  it("states the reply time from the facts", () => {
    expect(supportReplyTime(LEGAL_FACTS)).toBe("two business days");
    expect(replySentence(LEGAL_FACTS)).toBe("We reply within two business days.");
    expect(supportReplyTime({ ...LEGAL_FACTS, support: { email: "a@b.c", replyBusinessDays: 1 } })).toBe(
      "one business day",
    );
    expect(replySentence(SET)).toBe("We reply within three business days.");
  });
});

describe("founder supplied facts (decision 9)", () => {
  it("marks the entity and the governing law as pending until they are set", () => {
    const today = { ...LEGAL_FACTS, entity: { name: null, postalAddress: null, governingLaw: null } };
    expect(isPending(entitySentence(today))).toBe(true);
    expect(isPending(governingLawSentence(today))).toBe(true);
    expect(text(entitySentence(today))).toMatch(/^Pending: /);
    expect(text(governingLawSentence(today))).toMatch(/^Pending: /);
    expect(pendingLegalFacts(today)).toEqual(["entity.name", "entity.postalAddress", "entity.governingLaw"]);
  });

  it("keeps the entity pending while only part of it is set", () => {
    const half = { ...LEGAL_FACTS, entity: { name: "Curvi Example LLC", postalAddress: null, governingLaw: null } };
    expect(isPending(entitySentence(half))).toBe(true);
    expect(pendingLegalFacts(half)).toEqual(["entity.postalAddress", "entity.governingLaw"]);
  });

  it("prints the facts once the founder sets them", () => {
    expect(entitySentence(LEGAL_FACTS)).toBe(
      "Curvi is run by AIManagement Inc., 131 Continental Drive, Suite 305, Newark New Castle, DE 19713.",
    );
    expect(LEGAL_FACTS.entity.governingLaw).toBeNull();
    expect(isPending(governingLawSentence(LEGAL_FACTS))).toBe(true);
    expect(pendingLegalFacts(LEGAL_FACTS)).toEqual(["entity.governingLaw"]);
    expect(entitySentence(SET)).toBe(
      "Curvi is run by Curvi Example LLC, 1 Example Street, Springfield, IL 62701, United States.",
    );
    expect(governingLawSentence(SET)).toBe("These terms are governed by the laws of the State of Illinois, United States.");
    expect(pendingLegalFacts(SET)).toEqual([]);
  });
});

describe("renewal and changes", () => {
  it("promises the annual reminder only once P20-07 sets its window", () => {
    expect(annualReminderSentence({ ...LEGAL_FACTS, annualRenewalReminderDays: null })).toBeNull();
    expect(annualReminderSentence(SET)).toBe("For a yearly plan, we also email you 30 to 45 days before each renewal.");
  });

  it("states the change notice from the facts", () => {
    expect(termsChangeSentence(LEGAL_FACTS)).toContain(`at least ${LEGAL_FACTS.termsChangeNoticeDays} days before`);
    expect(termsChangeSentence(SET)).toContain("at least 14 days before");
  });
});

describe("copy rules", () => {
  it("keeps every sentence plain (rule 9) and sells nothing that is not live", () => {
    const today = { ...LEGAL_FACTS, entity: { name: null, postalAddress: null, governingLaw: null } };
    const all = [
      text(entitySentence(today)),
      text(governingLawSentence(today)),
      text(entitySentence(SET)),
      text(governingLawSentence(SET)),
      replySentence(LEGAL_FACTS),
      annualReminderSentence(SET) ?? "",
      termsChangeSentence(LEGAL_FACTS),
    ];
    for (const sentence of all) {
      expect(rule9Problems(sentence), sentence).toEqual([]);
      expect(unqualifiedClaims(sentence), sentence).toEqual([]);
    }
  });
});
