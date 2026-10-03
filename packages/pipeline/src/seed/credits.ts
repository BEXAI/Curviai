/**
 * Credit costs and tier definitions from CURVI_BUILD_PLAN.md section 9.1.
 * Prices and credit amounts live ONLY here (CLAUDE.md rule 2); they seed the
 * billing tables and are never hardcoded in logic code.
 */

import type { Shot } from "../schemas";
import { growthPlatformSettingSeedRows } from "./growth";
import { creditPlanningPolicy } from "./credit-planning";

export const creditCosts = {
  /** White main, cutout, resize or sweep. */
  deterministic: 0.5,
  /** One generative still at up to 2K. */
  generativeStill: 1,
  /** A 4K or Pro model still. */
  pro4kStill: 3,
  /** A templated video. */
  templatedVideo: 2,
  /** Generative video, per second, Lite. */
  generativeVideoPerSecondLite: 1,
  /** Generative video, per second, premium. */
  generativeVideoPerSecondPremium: 3,
  /** A UGC avatar ad. */
  ugcAvatarAd: 30,
} as const;

export type CreditCostKey = keyof typeof creditCosts;

/**
 * Plan features sold per tier (plan 9.1). Each one is either live (production
 * delivers it today) or coming_soon (Phase 10 decision 1: never billed as
 * included, only shown with a Coming soon label). Flip a status here when the
 * feature ships; entitlement checks, estimates and the runner's excluded shot
 * methods all follow it.
 */
export type TierFeature =
  | "sharePage"
  | "brandKit"
  | "templatedVideo"
  | "generativeVideo"
  | "lifestyleVideo"
  | "freshDrop"
  | "shopifyAutoPacks"
  | "ugcAds"
  | "multipleBrandKits"
  | "priorityQueue"
  | "clientWorkspaces"
  | "clientReviewLinks"
  | "whiteLabelShare"
  | "apiAccess"
  | "assistantAccess";

export type FeatureStatus = "live" | "coming_soon";

export const featureStatus: Record<TierFeature, FeatureStatus> = {
  // Owners publish a finished pack to /s/{slug} (Phase 11, b2/growth).
  sharePage: "live",
  // One kit per workspace: colors, fonts, logo and style preset feed the packs.
  brandKit: "live",
  // Video shots are skipped on real packs until their providers are wired.
  templatedVideo: "coming_soon",
  generativeVideo: "coming_soon",
  lifestyleVideo: "coming_soon",
  // The weekly drop cron reads a demo roster.
  freshDrop: "coming_soon",
  // No Shopify install exists; products/create is a logged stub.
  shopifyAutoPacks: "coming_soon",
  ugcAds: "coming_soon",
  // A workspace holds one brand kit.
  multipleBrandKits: "coming_soon",
  // Packs run inline with no queue or priority.
  priorityQueue: "coming_soon",
  clientWorkspaces: "coming_soon",
  clientReviewLinks: "coming_soon",
  whiteLabelShare: "coming_soon",
  // Workspace API keys, the public API v1 and the hosted MCP server
  // (PHASE_16 workstream 5, founder decision 5: Growth and up).
  apiAccess: "live",
  // Using Curvi from ChatGPT or another assistant through an OAuth sign in
  // to the hosted MCP server (PHASE_19 founder decision 3: every plan, Free
  // included, on the web app's credit rules). OpenAI's plugin guidelines do
  // not allow a plugin that is a worse version of the website, and every
  // plan can make packs on the web. API keys stay behind apiAccess.
  assistantAccess: "live",
};

export interface TierEntitlements {
  /** Brand kits one workspace on this tier may hold. */
  brandKits: number;
  /** Client workspaces an agency account may run. */
  clientWorkspaces: number;
  /** Features the plan includes, live or not. */
  features: readonly TierFeature[];
}

/** One line of a tier's "includes" list, tied to the feature it sells, or
 * null for lines that describe the pack itself rather than a feature. */
export interface TierIncludeLine {
  label: string;
  feature: TierFeature | null;
}

export interface TierDefinition {
  key: "free" | "starter" | "growth" | "pro" | "agency";
  monthlyUsd: number;
  /** Effective monthly price on the annual plan (about 20 percent off). */
  annualUsdPerMonth: number;
  /** Monthly credit allowance. Free is a one time grant, see creditsOnce. */
  creditsPerMonth: number;
  /** One time credit grant, used by the free tier. */
  creditsOnce: number;
  /**
   * Sold online: pricing shows the card and checkout takes the order
   * (docs/phases/PHASE_20.md P20-08, founder decision 6). False keeps the
   * tier for subscriptions the founder sets up by email, with no card on
   * /pricing or /app/billing, no required Stripe price and a checkout that
   * answers tier_not_self_serve.
   */
  selfServe: boolean;
  includes: string[];
}

/** Annual billing discount applied to monthly prices. */
export const annualDiscountPct = 0.2;

/**
 * The billing reconciler (docs/phases/PHASE_20.md P20-02): every
 * `everyMinutes` it replays the Stripe events of the last `lookbackHours`
 * through the webhook handler, at most `maxEventsPerRun` a run, so a
 * payment whose webhook never landed still grants its credits. Health warns
 * `stripe_webhook_quiet` when a checkout opened in the last
 * `quietWebhookDays` days and no webhook has succeeded since (P20-01).
 * Stripe keeps events for 30 days, so the lookback must stay well inside.
 */
export const billingReconcile = {
  lookbackHours: 72,
  maxEventsPerRun: 1000,
  everyMinutes: 30,
  quietWebhookDays: 7,
} as const;

const includeLines: Record<TierDefinition["key"], TierIncludeLine[]> = {
  free: [
    { label: "1 compliant main image plus 2 lifestyle", feature: null },
    { label: "share page", feature: "sharePage" },
  ],
  starter: [
    { label: "1 brand kit", feature: "brandKit" },
    { label: "all image assets", feature: null },
    { label: "templated video", feature: "templatedVideo" },
  ],
  growth: [
    { label: "generative video", feature: "generativeVideo" },
    { label: "Fresh Creative Drop", feature: "freshDrop" },
    { label: "Shopify auto packs", feature: "shopifyAutoPacks" },
  ],
  pro: [
    { label: "UGC hook ads", feature: "ugcAds" },
    { label: "3 brand kits", feature: "multipleBrandKits" },
    { label: "priority queue", feature: "priorityQueue" },
  ],
  agency: [
    { label: "10 client workspaces", feature: "clientWorkspaces" },
    { label: "client review links", feature: "clientReviewLinks" },
    { label: "white label share pages", feature: "whiteLabelShare" },
  ],
};

export const tiers: TierDefinition[] = [
  {
    key: "free",
    monthlyUsd: 0,
    annualUsdPerMonth: 0,
    creditsPerMonth: 0,
    creditsOnce: 15,
    selfServe: true,
    includes: includeLines.free.map((line) => line.label),
  },
  {
    key: "starter",
    monthlyUsd: 29,
    annualUsdPerMonth: 24,
    creditsPerMonth: 200,
    creditsOnce: 0,
    selfServe: true,
    includes: includeLines.starter.map((line) => line.label),
  },
  {
    key: "growth",
    monthlyUsd: 79,
    annualUsdPerMonth: 66,
    creditsPerMonth: 600,
    creditsOnce: 0,
    selfServe: true,
    includes: includeLines.growth.map((line) => line.label),
  },
  {
    key: "pro",
    monthlyUsd: 149,
    annualUsdPerMonth: 124,
    creditsPerMonth: 1300,
    creditsOnce: 0,
    selfServe: true,
    includes: includeLines.pro.map((line) => line.label),
  },
  {
    key: "agency",
    monthlyUsd: 349,
    annualUsdPerMonth: 290,
    creditsPerMonth: 3500,
    creditsOnce: 0,
    // Off self serve until client workspaces exist (PHASE_21, decision 6).
    selfServe: false,
    includes: includeLines.agency.map((line) => line.label),
  },
];

export type TierKey = TierDefinition["key"];

/**
 * What each tier is entitled to (plan 9.1). Tiers build on the one below
 * ("plus" in the tier table), so a feature listed for Growth is also in Pro
 * and Agency. The 15 second lifestyle clip and the UGC hook ad are Pro and
 * Agency only (plan 5.3 planner rule 3). Plan 9.1 names no brand kit count
 * for Agency; it keeps Pro's three per workspace.
 */
export const tierEntitlements: Record<TierKey, TierEntitlements> = {
  free: { brandKits: 0, clientWorkspaces: 0, features: ["sharePage", "assistantAccess"] },
  starter: {
    brandKits: 1,
    clientWorkspaces: 0,
    features: ["sharePage", "assistantAccess", "brandKit", "templatedVideo"],
  },
  growth: {
    brandKits: 1,
    clientWorkspaces: 0,
    features: [
      "sharePage",
      "assistantAccess",
      "brandKit",
      "templatedVideo",
      "generativeVideo",
      "freshDrop",
      "shopifyAutoPacks",
      "apiAccess",
    ],
  },
  pro: {
    brandKits: 3,
    clientWorkspaces: 0,
    features: [
      "sharePage",
      "assistantAccess",
      "brandKit",
      "templatedVideo",
      "generativeVideo",
      "freshDrop",
      "shopifyAutoPacks",
      "apiAccess",
      "lifestyleVideo",
      "ugcAds",
      "multipleBrandKits",
      "priorityQueue",
    ],
  },
  agency: {
    brandKits: 3,
    clientWorkspaces: 10,
    features: [
      "sharePage",
      "assistantAccess",
      "brandKit",
      "templatedVideo",
      "generativeVideo",
      "freshDrop",
      "shopifyAutoPacks",
      "apiAccess",
      "lifestyleVideo",
      "ugcAds",
      "multipleBrandKits",
      "priorityQueue",
      "clientWorkspaces",
      "clientReviewLinks",
      "whiteLabelShare",
    ],
  },
};

/**
 * Whether a tier's social exports carry the small "Made with Curvi" badge
 * (plan 9.6.3). Free packs carry it; paid plans ship clean files. Only specs
 * with badgeAllowed ever get it, so marketplace files never do on any plan.
 */
export const socialBadgeByTier: Record<TierKey, boolean> = {
  free: true,
  starter: false,
  growth: false,
  pro: false,
  agency: false,
};

/** Shot methods that deliver a plan feature. A method with no feature (the
 * still methods) is part of every pack. A method is deliverable while at
 * least one of its features is live. */
export const shotMethodFeatures: Record<Shot["method"], readonly TierFeature[]> = {
  deterministic: [],
  composite_generate: [],
  edit_generate: [],
  template: [],
  video_generate: ["templatedVideo", "generativeVideo", "lifestyleVideo"],
  avatar: ["ugcAds"],
};

/** Channel families that only carry a plan feature's output. A pack may
 * target one while at least one of those features is live and included. */
export const channelFamilyFeatures: Record<string, readonly TierFeature[]> = {
  video: ["templatedVideo", "generativeVideo", "lifestyleVideo"],
};

export function entitlementsFor(tier: TierKey): TierEntitlements {
  return tierEntitlements[tier] ?? tierEntitlements.free;
}

/** True when the plan includes the feature, whether or not it ships yet. */
export function isEntitled(tier: TierKey, feature: TierFeature): boolean {
  return entitlementsFor(tier).features.includes(feature);
}

export function isFeatureLive(feature: TierFeature): boolean {
  return featureStatus[feature] === "live";
}

/** True when the plan includes the feature and production delivers it today. */
export function canUse(tier: TierKey, feature: TierFeature): boolean {
  return isEntitled(tier, feature) && isFeatureLive(feature);
}

/** The cheapest tier whose plan includes the feature, for upgrade copy. */
export function lowestTierWith(feature: TierFeature): TierDefinition | null {
  return tiers.find((t) => isEntitled(t.key, feature)) ?? null;
}

/** The tier's includes list with each line's live or coming soon status, so
 * pricing and billing pages can label what does not ship yet. */
export function includesWithStatus(
  tier: TierKey,
): Array<TierIncludeLine & { status: FeatureStatus }> {
  return (includeLines[tier] ?? []).map((line) => ({
    ...line,
    status: line.feature ? featureStatus[line.feature] : "live",
  }));
}

export function isShotMethodDeliverable(method: Shot["method"]): boolean {
  const features = shotMethodFeatures[method] ?? [];
  return features.length === 0 || features.some(isFeatureLive);
}

/** Shot methods production cannot deliver yet. The db runtime skips them
 * after planning, and pack estimates and credit holds leave them out, so what
 * a pack holds matches what it can ship. */
export const undeliverableShotMethods: ReadonlyArray<Shot["method"]> = (
  Object.keys(shotMethodFeatures) as Array<Shot["method"]>
).filter((method) => !isShotMethodDeliverable(method));

export interface TopUp {
  credits: number;
  usd: number;
}

/** One time credit packs. Like every credit, they never expire while the
 * account is open (creditExpiry). */
export const topUps: TopUp[] = [
  { credits: 100, usd: 15 },
  { credits: 500, usd: 60 },
];

/**
 * How long credits last (docs/phases/PHASE_20.md founder decision 10,
 * P20-05): they never expire while the account is open, whether a plan, a
 * top up, a grant or a referral reward added them. No ledger row stores an
 * expiry and no copy states one. Choosing expiry instead needs credit lots
 * (FIFO use and expiry ledger rows), a later phase; until then this stays
 * "none" and a seed test keeps every other expiry field out.
 */
export const creditExpiry = { kind: "none" } as const;

/**
 * How prices are shown (docs/phases/PHASE_20.md P20-07, founder decision 3):
 * US prices exclude tax, so with Stripe Tax on, pricing and billing say tax
 * is added at checkout where it applies.
 */
export const taxDisplay = { pricesIncludeTax: false } as const;

/**
 * Renewal notices and consent records (P20-07, founder decision 4: the
 * strictest common state rules). Copy that states one of these numbers
 * renders it from here.
 * - annualDaysBefore: when the yearly plan reminder goes out, inside
 *   annualWindow ([earliest, latest] days before the renewal; California and
 *   New York ask for 15 to 45, Virginia 30 to 60).
 * - monthlyYearlyNotice: one notice a year to monthly subscribers
 *   (Minnesota's continuous service notice).
 * - priceChangeDaysBefore within priceChangeWindow: the notice before a
 *   price change applies to an existing subscriber (California, 7 to 30).
 * - consentRecordYears: how long a renewal consent record is kept
 *   (California: at least 3 years).
 * The reminders and notices themselves ship with P20-07's P1 part.
 */
export const renewalNotices = {
  annualDaysBefore: 35,
  annualWindow: [30, 45] as const,
  monthlyYearlyNotice: true,
  priceChangeDaysBefore: 21,
  priceChangeWindow: [7, 30] as const,
  consentRecordYears: 3,
  /** California keeps the consent record for the longer of
   * consentRecordYears from the purchase and this many years after the
   * plan ends (law and copy review 9). */
  consentRecordYearsAfterPlanEnds: 1,
} as const;

/** Launch offer (plan 9.2 and 9.7): Starter locked for life for the first
 * founding members. PHASE_18 P18-21 and founder decision 13: `seats` seats,
 * open through `endsOn` (a UTC day, inclusive), delivered as Stripe
 * promotion codes the founder creates. One coupon takes one amount, so
 * there are two: `code` brings Starter monthly to monthlyUsd and
 * `annualCode` Starter annual to annualUsd, and the seats are shared
 * between them (apps/web/src/lib/offer/founding.ts). */
export const foundingMemberOffer = {
  monthlyUsd: 19,
  annualUsd: 190,
  seats: 50,
  code: "FOUNDING",
  annualCode: "FOUNDINGYEAR",
  endsOn: "2026-11-30",
} as const;

/** Referral give and get credits (plan 9.6.2; PHASE_18 P18-24 and founder
 * decision 12): `credits` to each side when the referred workspace makes
 * its first payment, at most `monthlyCapPerReferrer` rewarded referrals per
 * referrer per calendar month (UTC), reward credits never expire, like every
 * other grant (creditExpiry, docs/phases/PHASE_20.md P20-05), and a refund
 * or dispute of that payment
 * within `clawbackDays` takes both rewards back. Off until the
 * referrals_enabled switch (growth.ts) is turned on. */
export const referralReward = {
  credits: 50,
  monthlyCapPerReferrer: 10,
  clawbackDays: 30,
} as const;

export function tierByKey(key: TierKey): TierDefinition {
  const tier = tiers.find((t) => t.key === key);
  if (!tier) {
    throw new Error(`Unknown tier: ${key}`);
  }
  return tier;
}

/** One platform_settings row: a tunable the database reads directly. */
export interface PlatformSettingSeedRow {
  key: string;
  value: number | string | boolean;
  /** Written only when the row is missing: a switch the founder flips by
   * SQL keeps its stored value through every later seed (PHASE_18). */
  keepStored?: boolean;
}

/** Settings pnpm db:seed upserts into platform_settings (migration 0012).
 * free_signup_credits is the free tier's one time grant, which the
 * grant_signup_credits function pays once a user's email is confirmed. */
export const platformSettingSeedRows: PlatformSettingSeedRow[] = [
  { key: "free_signup_credits", value: tierByKey("free").creditsOnce },
  { key: "credit_budget_period", value: creditPlanningPolicy.period, keepStored: true },
  { key: "credit_budget_max_monthly", value: creditPlanningPolicy.maxMonthlyCredits, keepStored: true },
  // Operator switches are never seeded (P20-20): the output options kill
  // switch is ops:output_options_enabled, read through opsSwitch with its
  // default in operations.ts, and the loader refuses any ops: row.
  // Phase 18 switches, one list per lane in growth.ts.
  ...growthPlatformSettingSeedRows,
];
