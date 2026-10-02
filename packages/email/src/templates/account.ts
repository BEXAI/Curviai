/**
 * Lifecycle emails to a signed up account (docs/phases/PHASE_18.md P18-07).
 * The copy is the plan's draft (the founder may edit it; docs/marketing.md
 * T-EM-01 to T-EM-07 are its sources) and passes the copy lint in
 * templates.test.ts and the claims guards in the web app's
 * lifecycle-templates.test.ts. Plain spoken, no emojis, arrows or dashes
 * used as punctuation (CLAUDE.md rule 9). Credits never "expire" in this
 * copy: subscription credits never do, and top ups last a seeded number of
 * months.
 */

import type { EmailTemplate } from "../render";
import { credits, deltaE, dollars, files, packsFor, packsReach, productName } from "./format";

/** Seed numbers the account emails quote, filled by the cron. */
export interface PricingFacts {
  /** The free plan's one time grant. */
  freeCredits: number;
  /** Credits a default listing pack of stills uses. */
  typicalPackCredits: number;
  starter: { monthlyUsd: number; credits: number };
  /** The smallest top up. */
  topUp: { usd: number; credits: number };
  /** The one sentence about how long credits last (CREDIT_TERMS_SENTENCE
   * in apps/web lib/marketing-facts.ts, docs/phases/PHASE_20.md P20-05):
   * credits never expire, so no email states a credit lifetime. */
  creditTerms: string;
}

export interface WelcomeData {
  pricing: PricingFacts;
  /** The free credits this account was granted (signup_grants). 0 when the
   * grant was withheld (an inbox that already had one, migration 0012) or
   * has not landed: the credits sentence is then left out. */
  freeCredits: number;
  /** Packs are paused right now (P18-03): the email says so. */
  packsPaused: boolean;
}

export const welcomeEmail: EmailTemplate<WelcomeData> = {
  key: "welcome",
  kind: "transactional",
  audience: "account",
  render: (data, ctx) => {
    const free = data.freeCredits;
    const make = `Upload one product photo and Curvi makes your Amazon main image, lifestyle scenes and social sizes, without redrawing your product: ${ctx.link("/app/new")}`;
    const paragraphs = [
      ctx.founderName ? `Hi, I am ${ctx.founderName}, and I build Curvi myself.` : "Hi, I build Curvi myself.",
      free > 0
        ? `You have ${free} free ${free === 1 ? "credit" : "credits"}, ${packsReach(free, data.pricing.typicalPackCredits)}. ${make}`
        : make,
    ];
    if (data.packsPaused) {
      paragraphs.push("Packs are paused for a short while right now. We will email you the moment they are back.");
    }
    paragraphs.push("Short on time? Reply with a link to your product and I will make your first pack for you.");
    return { subject: "Your Curvi account is ready", paragraphs };
  },
};

export const firstPackNudge1Email: EmailTemplate<Record<string, never>> = {
  key: "first_pack_nudge_1",
  kind: "marketing",
  audience: "account",
  render: (_data, ctx) => ({
    subject: "Your free pack is waiting",
    paragraphs: [`One photo is all it takes. A phone photo on any plain surface works: ${ctx.link("/app/new")}`],
  }),
};

export const firstPackNudge2Email: EmailTemplate<Record<string, never>> = {
  key: "first_pack_nudge_2",
  kind: "marketing",
  audience: "account",
  render: (_data, ctx) => ({
    subject: "Want me to make your first pack?",
    paragraphs: [
      "If you have not had time, reply with one photo of your best selling product and tell me where you sell. I will make the pack and send you the link. It will not use your free credits.",
      `Or make it yourself in a few minutes: ${ctx.link("/app/new")}`,
    ],
  }),
};

/** The measured product check of a finished pack (P18-08), when it has one. */
export interface PackFidelity {
  /** The highest average color difference inside the product across the delivered files. */
  highestMean: number;
  /** Every measured file is inside its own limit. */
  allWithinLimits: boolean;
}

export interface PackReadyData {
  jobId: string;
  productTitle: string | null;
  passed: number;
  needsReview: number;
  fidelity: PackFidelity | null;
}

export const packReadyEmail: EmailTemplate<PackReadyData> = {
  key: "pack_ready",
  kind: "transactional",
  audience: "account",
  render: (data, ctx) => {
    const name = productName(data.productTitle);
    const packLink = ctx.link(`/app/jobs/${encodeURIComponent(data.jobId)}`);
    const checks = [`${files(data.passed)} passed ${data.passed === 1 ? "its" : "their"} channel checks.`];
    if (data.needsReview > 0) {
      checks.push(`${files(data.needsReview)} ${data.needsReview === 1 ? "is" : "are"} marked for review and not charged.`);
    }
    if (data.fidelity && data.fidelity.allWithinLimits) {
      checks.push(
        `Inside your product, the average color difference was ${deltaE(data.fidelity.highestMean)} at most, within every file's limit, because the product was never redrawn.`,
      );
    }
    return {
      subject: name ? `Your ${name} pack is ready` : "Your Curvi pack is ready",
      paragraphs: [
        checks.join(" "),
        `Download them here: ${packLink}`,
        `Want to show someone? Share the before and after from the same page: ${packLink}`,
      ],
    };
  },
};

export interface FeedbackAskData {
  path: string;
}

export const feedbackAskEmail: EmailTemplate<FeedbackAskData> = {
  key: "feedback_ask",
  kind: "marketing",
  audience: "account",
  render: (data, ctx) => ({
    subject: "Would you use these files?",
    paragraphs: [
      `One tap tells me if your pack is usable as it is: ${ctx.link(data.path)}`,
      "If something is off, reply and tell me what. I read every answer.",
    ],
  }),
};

/** A receipt for credits already granted, without identifying the other seller. */
export const referralRewardedEmail: EmailTemplate<{ credits: number }> = {
  key: "referral_rewarded",
  kind: "transactional",
  audience: "account",
  render: (data, ctx) => ({
    subject: "Your referral credits were added",
    paragraphs: [
      `Your referral qualified and ${credits(data.credits)} were added to your Curvi balance.`,
      `See your balance: ${ctx.link("/app/billing")}`,
    ],
  }),
};

export interface OutOfCreditsData {
  plan: string;
  balance: number;
  pricing: PricingFacts;
}

export const outOfCreditsEmail: EmailTemplate<OutOfCreditsData> = {
  key: "out_of_credits",
  kind: "marketing",
  audience: "account",
  render: (data, ctx) => {
    const { pricing } = data;
    const left = Math.max(0, data.balance);
    const topUp = `Top ups start at ${dollars(pricing.topUp.usd)}.`;
    const pricingLink = ctx.link("/pricing");
    if (data.plan === "free") {
      return {
        subject: left > 0 ? `You have ${credits(left)} left` : "You have used your free credits",
        paragraphs: [
          `Starter is ${dollars(pricing.starter.monthlyUsd)} a month for ${pricing.starter.credits} credits, about ${packsFor(pricing.starter.credits, pricing.typicalPackCredits)} packs. ${topUp} ${pricing.creditTerms}`,
          `See plans and top ups: ${pricingLink}`,
        ],
      };
    }
    const packs = packsFor(left, pricing.typicalPackCredits);
    return {
      subject: `You have ${credits(left)} left`,
      paragraphs: [
        `You have ${credits(left)} left, ${packs === 1 ? "about 1 typical pack" : `about ${packs} typical packs`}. ${pricing.creditTerms} ${topUp}`,
        `See plans and top ups: ${pricingLink}`,
      ],
    };
  },
};

export const winBackEmail: EmailTemplate<Record<string, never>> = {
  key: "win_back",
  kind: "marketing",
  audience: "account",
  render: (_data, ctx) => ({
    subject: "New products to list?",
    paragraphs: [
      `If you have new products for the holidays, one photo each is enough. Your products and settings are saved: ${ctx.link("/app/new")}`,
    ],
  }),
};

export const packsBackAccountEmail: EmailTemplate<Record<string, never>> = {
  key: "packs_back",
  kind: "transactional",
  audience: "account",
  render: (_data, ctx) => ({
    subject: "Curvi packs are back",
    paragraphs: [`Thanks for waiting. Packs are running again: ${ctx.link("/app/new")}`],
  }),
};
