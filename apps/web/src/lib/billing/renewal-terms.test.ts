import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renewalNotices, tierByKey } from "@curvi/pipeline/seed";
import { rule9Problems } from "@curvi/pipeline";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { checkoutDisclosure, CHECKOUT_CUSTOM_TEXT_MAX } from "./checkout";
import { formatUsd, priceForCadence, selfServeTierKeys, tierDisplayName, BILLING_CADENCES } from "./plans";
import {
  firstRenewal,
  formatRenewalDate,
  PRICE_CHANGE_LINE,
  promotionCodeLine,
  renewalCheckboxText,
  renewalDisclosure,
  renewalTerms,
  RENEWAL_DISCLOSURE_VERSION,
  showTaxLine,
  TAX_LINE,
  YEARLY_CANCEL_LINE,
} from "./renewal-terms";

// docs/phases/PHASE_20.md P20-07: the renewal terms beside every plan buy
// button and in Checkout, built from the seed.

const NOW = new Date("2026-10-02T15:00:00Z");

describe("renewal disclosures", () => {
  it("states each plan's price and cadence from the seed", () => {
    for (const tier of selfServeTierKeys) {
      for (const cadence of BILLING_CADENCES) {
        const text = renewalDisclosure({ tier, cadence });
        const price = formatUsd(priceForCadence(tierByKey(tier), cadence).billedUsd);
        expect(text).toContain(`Your Curvi ${tierDisplayName(tier)} plan renews automatically every ${cadence === "annual" ? "year" : "month"} at ${price} plus any tax that applies, until you cancel.`);
        expect(text).toContain("Cancel any time online in Billing.");
        expect(text).toContain("There is no minimum term.");
      }
    }
  });

  it("renders the yearly reminder window from the seed, on yearly plans only", () => {
    const [earliest, latest] = renewalNotices.annualWindow;
    expect(renewalDisclosure({ tier: "growth", cadence: "annual" })).toContain(
      `We email you ${earliest} to ${latest} days before each renewal.`,
    );
    expect(renewalDisclosure({ tier: "growth", cadence: "monthly" })).not.toContain("days before each renewal");
    expect(renewalDisclosure({ tier: "growth", cadence: "monthly" })).toContain(
      "You keep your plan until the end of the month you paid for.",
    );
  });

  it("names the date to cancel by when it is known, and the renewal date otherwise", () => {
    expect(renewalDisclosure({ tier: "starter", cadence: "monthly", renewsOn: firstRenewal(NOW, "monthly") })).toContain(
      "To avoid the next charge, cancel before November 2, 2026.",
    );
    expect(renewalDisclosure({ tier: "starter", cadence: "annual", renewsOn: firstRenewal(NOW, "annual") })).toContain(
      "cancel before October 2, 2027.",
    );
    expect(renewalDisclosure({ tier: "starter", cadence: "monthly" })).toContain(
      "To avoid the next charge, cancel before your next renewal date.",
    );
    expect(formatRenewalDate(new Date("2027-01-31T00:00:00Z"))).toBe("January 31, 2027");
    expect(firstRenewal(new Date("2026-01-31T12:00:00Z"), "monthly").toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("says what canceling a yearly plan means (law and copy review major 1)", () => {
    expect(YEARLY_CANCEL_LINE).toBe(
      "If you cancel, you keep your plan until the end of the year you paid for. We do not refund the rest of the year.",
    );
    expect(renewalDisclosure({ tier: "growth", cadence: "annual" })).toContain(YEARLY_CANCEL_LINE);
    expect(renewalDisclosure({ tier: "growth", cadence: "monthly" })).not.toContain(YEARLY_CANCEL_LINE);
  });

  it("adds the price change line beside the button", () => {
    expect(renewalTerms({ tier: "pro", cadence: "monthly" }).endsWith(PRICE_CHANGE_LINE)).toBe(true);
  });

  it("asks for consent to the automatic renewal and the terms in the checkbox", () => {
    expect(renewalCheckboxText("https://curvi.ai")).toBe(
      "I agree that my plan renews automatically at the price above until I cancel, and I agree to the [Terms of Service](https://curvi.ai/terms).",
    );
  });

  it("shows the tax line only while Stripe Tax is on", () => {
    expect(showTaxLine(true)).toBe(true);
    expect(showTaxLine(false)).toBe(false);
    expect(TAX_LINE).toBe("Prices are in US dollars. Tax is added at checkout where it applies.");
  });

  it("keeps every line plain (rule 9) and sells nothing that does not run", () => {
    const texts = [
      PRICE_CHANGE_LINE,
      TAX_LINE,
      renewalCheckboxText("https://curvi.ai"),
      ...selfServeTierKeys.flatMap((tier) =>
        BILLING_CADENCES.map((cadence) => renewalTerms({ tier, cadence, renewsOn: firstRenewal(NOW, cadence) })),
      ),
    ];
    for (const text of texts) {
      expect(rule9Problems(text), text).toEqual([]);
      expect(unqualifiedClaims(text), text).toEqual([]);
    }
  });
});

describe("the Checkout disclosure", () => {
  it("fits Stripe's 1200 character limit for every plan and cadence, with the version and a hash", () => {
    for (const tier of selfServeTierKeys) {
      for (const cadence of BILLING_CADENCES) {
        const disclosure = checkoutDisclosure({ tier, cadence, siteUrl: "https://curvi.ai", now: NOW });
        expect(disclosure.submit.length).toBeLessThanOrEqual(CHECKOUT_CUSTOM_TEXT_MAX);
        expect(disclosure.acceptance.length).toBeLessThanOrEqual(CHECKOUT_CUSTOM_TEXT_MAX);
        expect(disclosure.version).toBe(RENEWAL_DISCLOSURE_VERSION);
        expect(disclosure.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("says beside the pay button what a promotion code changes and the renewal price after it (law and copy review major 2)", () => {
    const monthly = checkoutDisclosure({ tier: "starter", cadence: "monthly", siteUrl: "https://curvi.ai", now: NOW });
    const price = formatUsd(priceForCadence(tierByKey("starter"), "monthly").billedUsd);
    expect(monthly.submit.endsWith(promotionCodeLine("starter", "monthly"))).toBe(true);
    expect(promotionCodeLine("starter", "monthly")).toBe(
      `If you use a promotion code, Checkout shows the discounted price and how long it lasts. After that, your plan renews at ${price} a month.`,
    );
    const yearly = checkoutDisclosure({ tier: "pro", cadence: "annual", siteUrl: "https://curvi.ai", now: NOW });
    expect(yearly.submit).toContain(
      `After that, your plan renews at ${formatUsd(priceForCadence(tierByKey("pro"), "annual").billedUsd)} a year.`,
    );
    expect(rule9Problems(promotionCodeLine("growth", "annual"))).toEqual([]);
    // The site's buy buttons have no code field, so their terms leave it out.
    expect(renewalTerms({ tier: "starter", cadence: "monthly" })).not.toContain("promotion code");
  });

  it("changes the hash whenever the text shown changes", () => {
    const a = checkoutDisclosure({ tier: "growth", cadence: "monthly", siteUrl: "https://curvi.ai", now: NOW });
    const b = checkoutDisclosure({ tier: "growth", cadence: "annual", siteUrl: "https://curvi.ai", now: NOW });
    const c = checkoutDisclosure({ tier: "growth", cadence: "monthly", siteUrl: "https://curvi.ai", now: new Date("2026-10-03T15:00:00Z") });
    expect(new Set([a.sha256, b.sha256, c.sha256]).size).toBe(3);
    expect(checkoutDisclosure({ tier: "growth", cadence: "monthly", siteUrl: "https://curvi.ai", now: NOW }).sha256).toBe(a.sha256);
  });
});

describe("the disclosure version moves with the text (law and copy review major 8)", () => {
  // A fingerprint of every renewal text a buyer can see, per plan and
  // cadence, at a fixed date. When the wording changes, change
  // RENEWAL_DISCLOSURE_VERSION with it and record the new version and
  // fingerprint here. Never record a new fingerprint under an old version:
  // consent rows name the version, so one version must mean one text.
  const RECORDED: Record<string, string> = {
    "2026-10-02.2": "d4a20f235faaf7fde3edd55f84aec86f8899414bd241627b4d2ca255dc614bc9",
  };

  function fingerprint(): string {
    const texts: string[] = [renewalCheckboxText("https://curvi.ai"), PRICE_CHANGE_LINE, TAX_LINE];
    for (const tier of selfServeTierKeys) {
      for (const cadence of BILLING_CADENCES) {
        texts.push(renewalTerms({ tier, cadence }));
        texts.push(renewalTerms({ tier, cadence, renewsOn: firstRenewal(NOW, cadence) }));
        const disclosure = checkoutDisclosure({ tier, cadence, siteUrl: "https://curvi.ai", now: NOW });
        texts.push(disclosure.submit, disclosure.acceptance);
      }
    }
    return createHash("sha256").update(texts.join("\n")).digest("hex");
  }

  it("has a fingerprint recorded for the current version's text", () => {
    expect({ version: RENEWAL_DISCLOSURE_VERSION, sha256: fingerprint() }).toEqual({
      version: RENEWAL_DISCLOSURE_VERSION,
      sha256: RECORDED[RENEWAL_DISCLOSURE_VERSION],
    });
  });
});
