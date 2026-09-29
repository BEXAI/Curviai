/**
 * Credit costs and tier definitions from CURVI_BUILD_PLAN.md section 9.1.
 * Prices and credit amounts live ONLY here (CLAUDE.md rule 2); they seed the
 * billing tables and are never hardcoded in logic code.
 */

import type { Shot } from "../schemas";

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
  | "apiAccess";

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
  includes: string[];
}

/** Annual billing discount applied to monthly prices. */
export const annualDiscountPct = 0.2;

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
    includes: includeLines.free.map((line) => line.label),
  },
  {
    key: "starter",
    monthlyUsd: 29,
    annualUsdPerMonth: 24,
    creditsPerMonth: 200,
    creditsOnce: 0,
    includes: includeLines.starter.map((line) => line.label),
  },
  {
    key: "growth",
    monthlyUsd: 79,
    annualUsdPerMonth: 66,
    creditsPerMonth: 600,
    creditsOnce: 0,
    includes: includeLines.growth.map((line) => line.label),
  },
  {
    key: "pro",
    monthlyUsd: 149,
    annualUsdPerMonth: 124,
    creditsPerMonth: 1300,
    creditsOnce: 0,
    includes: includeLines.pro.map((line) => line.label),
  },
  {
    key: "agency",
    monthlyUsd: 349,
    annualUsdPerMonth: 290,
    creditsPerMonth: 3500,
    creditsOnce: 0,
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
  free: { brandKits: 0, clientWorkspaces: 0, features: ["sharePage"] },
  starter: {
    brandKits: 1,
    clientWorkspaces: 0,
    features: ["sharePage", "brandKit", "templatedVideo"],
  },
  growth: {
    brandKits: 1,
    clientWorkspaces: 0,
    features: [
      "sharePage",
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
  /** Months before top up credits expire. */
  expiresMonths: number;
}

export const topUps: TopUp[] = [
  { credits: 100, usd: 15, expiresMonths: 12 },
  { credits: 500, usd: 60, expiresMonths: 12 },
];

/** Unused subscription credits roll over for one cycle, capped at one month's allowance. */
export const rolloverPolicy = { cycles: 1, capFactorOfMonthlyAllowance: 1 } as const;

/** Launch offer (plan 9.2 and 9.7): Starter locked for life for the first
 * founding members. */
export const foundingMemberOffer = { monthlyUsd: 19, annualUsd: 190, seats: 50 } as const;

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
}

/** Settings pnpm db:seed upserts into platform_settings (migration 0012).
 * free_signup_credits is the free tier's one time grant, which the
 * grant_signup_credits function pays once a user's email is confirmed. */
export const platformSettingSeedRows: PlatformSettingSeedRow[] = [
  { key: "free_signup_credits", value: tierByKey("free").creditsOnce },
  // Kill switch for seller output options (PHASE_15). createJob refuses non
  // default options while it is false, whatever the web flag says.
  { key: "output_options_enabled", value: true },
];
