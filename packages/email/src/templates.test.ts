import { describe, expect, it } from "vitest";
import { lifecycleSchedule, lifecycleTemplateKeys } from "@curvi/pipeline/seed";
import { fixedEmailCopy } from "./copy";
import { renderEmail, type EmailTemplate, type RenderOptions } from "./render";
import {
  LEAD_TOOLS,
  feedbackAskEmail,
  firstPackNudge1Email,
  firstPackNudge2Email,
  leadOfferEmail,
  leadResultsEmail,
  leadTipEmail,
  lifecycleTemplates,
  outOfCreditsEmail,
  packReadyEmail,
  packsBackAccountEmail,
  packsBackLeadEmail,
  referralRewardedEmail,
  welcomeEmail,
  winBackEmail,
  type PricingFacts,
} from "./templates";

// The lifecycle email copy (P18-07): every subject and body passes the rule
// 9 lint (no emojis, arrows or dashes used as punctuation), never pairs
// credits with expiry, and renders as the snapshots below. The claims
// guards run on the same renders in apps/web lifecycle-templates.test.ts.

const PRICING: PricingFacts = {
  freeCredits: 15,
  typicalPackCredits: 8,
  starter: { monthlyUsd: 29, credits: 200 },
  topUp: { usd: 15, credits: 100 },
  creditTerms: "Credits you do not use stay in your balance from one month to the next, for as long as your account is open.",
};

const MARKETING: RenderOptions = {
  siteUrl: "https://curvi.ai",
  founderName: "Sam",
  unsubscribe: {
    pageUrl: "https://curvi.ai/email/unsubscribe?t=TOKEN",
    oneClickUrl: "https://curvi.ai/api/email/unsubscribe?t=TOKEN",
    mailto: "support@curvi.ai",
  },
  postalAddress: "PO Box 100, Springfield, IL 62701",
};

/** Every template with every data shape it takes. */
function sampleRenders(options: RenderOptions = MARKETING) {
  const cases: [string, EmailTemplate<never>, unknown][] = [
    ["welcome", welcomeEmail as EmailTemplate<never>, { pricing: PRICING, freeCredits: 15, packsPaused: false }],
    ["welcome while paused", welcomeEmail as EmailTemplate<never>, { pricing: PRICING, freeCredits: 15, packsPaused: true }],
    ["welcome after a withheld grant", welcomeEmail as EmailTemplate<never>, { pricing: PRICING, freeCredits: 0, packsPaused: false }],
    ["first_pack_nudge_1", firstPackNudge1Email as EmailTemplate<never>, {}],
    ["first_pack_nudge_2", firstPackNudge2Email as EmailTemplate<never>, {}],
    [
      "pack_ready",
      packReadyEmail as EmailTemplate<never>,
      { jobId: "job-1", productTitle: "Amber Candle", passed: 6, needsReview: 1, fidelity: { highestMean: 0.843, allWithinLimits: true } },
    ],
    ["pack_ready without numbers", packReadyEmail as EmailTemplate<never>, { jobId: "job-2", productTitle: null, passed: 1, needsReview: 0, fidelity: null }],
    ["feedback_ask", feedbackAskEmail as EmailTemplate<never>, { path: "/feedback/signed-token" }],
    ["referral_rewarded", referralRewardedEmail as EmailTemplate<never>, { credits: 37 }],
    ["out_of_credits free", outOfCreditsEmail as EmailTemplate<never>, { plan: "free", balance: 0, pricing: PRICING }],
    ["out_of_credits free with some left", outOfCreditsEmail as EmailTemplate<never>, { plan: "free", balance: 3.5, pricing: PRICING }],
    ["out_of_credits starter", outOfCreditsEmail as EmailTemplate<never>, { plan: "starter", balance: 6, pricing: PRICING }],
    ["win_back", winBackEmail as EmailTemplate<never>, {}],
    ["packs_back account", packsBackAccountEmail as EmailTemplate<never>, {}],
    ["packs_back lead", packsBackLeadEmail as EmailTemplate<never>, {}],
    ...Object.keys(LEAD_TOOLS).map(
      (source) => [`lead_results ${source}`, leadResultsEmail as EmailTemplate<never>, { source }] as [string, EmailTemplate<never>, unknown],
    ),
    ["lead_tip", leadTipEmail as EmailTemplate<never>, {}],
    ["lead_offer", leadOfferEmail as EmailTemplate<never>, { freeCredits: 15 }],
  ];
  return cases.map(([name, template, data]) => ({ name, template, email: renderEmail(template, data as never, options) }));
}

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;
const EXPIRY_NEAR_CREDITS = /credits?\b[^.]{0,60}\bexpir|\bexpir[^.]{0,60}\bcredits?\b/i;

describe("lifecycle templates", () => {
  it("match the seeded template keys one to one", () => {
    expect([...new Set(lifecycleTemplates.map((t) => t.key))].sort()).toEqual([...lifecycleTemplateKeys].sort());
    expect(Object.keys(lifecycleSchedule.templates).sort()).toEqual([...lifecycleTemplateKeys].sort());
  });

  it("are plain spoken: no emojis, arrows or dashes as punctuation, in every subject and body", () => {
    for (const { name, email } of sampleRenders()) {
      for (const text of [email.subject, email.text]) {
        expect(text, name).not.toMatch(FORBIDDEN_COPY);
      }
    }
    for (const line of fixedEmailCopy) {
      expect(line).not.toMatch(FORBIDDEN_COPY);
    }
  });

  it("never pair credits with expiry", () => {
    for (const { name, email } of sampleRenders()) {
      expect(`${email.subject}\n${email.text}`, name).not.toMatch(EXPIRY_NEAR_CREDITS);
    }
    expect("Your credits expire soon").toMatch(EXPIRY_NEAR_CREDITS);
  });

  it("carry the unsubscribe footer and headers on every marketing email and none on transactional ones", () => {
    for (const { name, template, email } of sampleRenders()) {
      if (template.kind === "marketing") {
        expect(email.text, name).toContain("This is a marketing email from Curvi.");
        expect(email.text, name).toContain("Unsubscribe in one click: https://curvi.ai/email/unsubscribe?t=TOKEN");
        expect(email.text, name).toContain("Curvi, PO Box 100, Springfield, IL 62701");
        expect(email.headers["List-Unsubscribe-Post"], name).toBe("List-Unsubscribe=One-Click");
      } else {
        expect(email.text, name).not.toContain("Unsubscribe");
        expect(email.headers, name).toEqual({});
      }
    }
  });

  it("tag every link with the email UTM values and their own template", () => {
    for (const { name, template, email } of sampleRenders()) {
      const links = email.text.match(/https:\/\/curvi\.ai\/[^\s]+/g) ?? [];
      for (const link of links.filter((l) => !l.includes("/email/unsubscribe"))) {
        const url = new URL(link);
        expect(url.searchParams.get("utm_source"), name).toBe("curvi_email");
        expect(url.searchParams.get("utm_medium"), name).toBe("email");
        expect(url.searchParams.get("utm_campaign"), name).toBe(template.key);
      }
    }
  });

  it("says the measured product check only when every file is inside its limit", () => {
    const outside = renderEmail(
      packReadyEmail,
      { jobId: "j", productTitle: "Cup", passed: 2, needsReview: 0, fidelity: { highestMean: 4, allWithinLimits: false } },
      MARKETING,
    );
    expect(outside.text).not.toContain("color difference");
  });

  it("render as drafted", () => {
    for (const { name, email } of sampleRenders()) {
      expect({ subject: email.subject, text: email.text }).toMatchSnapshot(name);
    }
  });
});
