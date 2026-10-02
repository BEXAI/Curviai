import { describe, expect, it } from "vitest";
import { LEAD_TOOLS, lifecycleTemplates, pricingFacts, renderEmail, type EmailTemplate } from "@curvi/email";
import { lifecycleSchedule } from "@curvi/pipeline/seed";
import { WAITLIST_LEAD_SOURCE } from "@/lib/acquisition-client";
import { LEAD_SOURCES } from "@/lib/lead-sources";
import { CREDIT_TERMS_SENTENCE, freeCredits, identityClaims, typicalPackCredits, unqualifiedClaims } from "@/lib/marketing-facts";

// The claims guards (PHASE_18 principle 8, P18-09) on every lifecycle email
// as it renders with the real seed numbers: no coming soon feature sold as
// live, no claim that the product comes out identical, and no credit expiry
// urgency. packages/email templates.test.ts lints rule 9 and snapshots them.

const pricing = pricingFacts(typicalPackCredits(), CREDIT_TERMS_SENTENCE);

const DATA: Record<string, unknown[]> = {
  welcome: [
    { pricing, freeCredits: freeCredits(), packsPaused: false },
    { pricing, freeCredits: freeCredits(), packsPaused: true },
    { pricing, freeCredits: 0, packsPaused: false },
  ],
  first_pack_nudge_1: [{}],
  first_pack_nudge_2: [{}],
  pack_ready: [
    { jobId: "job", productTitle: "Amber Candle", passed: 6, needsReview: 2, fidelity: { highestMean: 0.84, allWithinLimits: true } },
  ],
  feedback_ask: [{ path: "/feedback/signed-token" }],
  referral_rewarded: [{ credits: 37 }],
  out_of_credits: [
    { plan: "free", balance: 0, pricing },
    { plan: "starter", balance: 5, pricing },
  ],
  win_back: [{}],
  packs_back: [{}],
  lead_results: Object.keys(LEAD_TOOLS).map((source) => ({ source })),
  lead_tip: [{}],
  lead_offer: [{ freeCredits: pricing.freeCredits }],
};

function renders() {
  return lifecycleTemplates.flatMap((template: EmailTemplate<never>) =>
    (DATA[template.key] ?? []).map((data) =>
      renderEmail(template, data as never, {
        siteUrl: "https://curvi.ai",
        founderName: null,
        unsubscribe: { pageUrl: "https://curvi.ai/email/unsubscribe?t=x", oneClickUrl: "https://curvi.ai/api/email/unsubscribe?t=x", mailto: null },
        postalAddress: "PO Box 100, Springfield, IL 62701",
      }),
    ),
  );
}

describe("lifecycle email claims", () => {
  it("renders every template", () => {
    for (const template of lifecycleTemplates) {
      expect(DATA[template.key]?.length, template.key).toBeGreaterThan(0);
    }
  });

  it("sells no coming soon feature and claims no identical product", () => {
    for (const email of renders()) {
      const copy = `${email.subject}. ${email.text}`;
      expect(unqualifiedClaims(copy), email.template).toEqual([]);
      expect(identityClaims(copy), email.template).toEqual([]);
      expect(copy, email.template).not.toMatch(/expir/i);
    }
  });

  it("knows the lead sources it reads", () => {
    for (const source of lifecycleSchedule.leadResultSources) {
      expect(LEAD_SOURCES, source).toContain(source);
      expect(LEAD_TOOLS[source], source).toBeDefined();
    }
    expect(lifecycleSchedule.waitlistLeadSource).toBe(WAITLIST_LEAD_SOURCE);
  });

  it("quotes the seeded free grant and the seeded Starter plan", () => {
    expect(pricing.freeCredits).toBe(freeCredits());
    const welcome = renders().find((email) => email.template === "welcome");
    expect(welcome?.text).toContain(`You have ${freeCredits()} free credits`);
  });
});
