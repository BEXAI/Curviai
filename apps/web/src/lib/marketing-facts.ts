import { getSpec, listSpecs } from "@curvi/specs";
import { rolloverPolicy, tierByKey, tiers, topUps, type TierKey } from "@curvi/pipeline/seed";
import { estimatePackCredits } from "@/lib/pack-estimate";

/**
 * The facts marketing, help and dashboard copy is allowed to state. Numbers
 * come from the seeds and the spec registry (CLAUDE.md rule 2), and every
 * feature carries an availability flag, so copy can never sell something
 * that does not run in production (Phase 10 decision 1). Flip a flag to
 * "live" in the same change that ships the feature.
 */

export type Availability = "live" | "coming_soon";

export const COMING_SOON_LABEL = "Coming soon";

// Numbers

/**
 * The channels the new pack form preselects. Keep in step with
 * DEFAULT_CHANNELS in components/app/new-pack-form.tsx; a test checks it.
 */
export const TYPICAL_PACK_CHANNELS: readonly string[] = [
  "amazon.main",
  "amazon.secondary",
  "shopify.product",
  "meta.feed_1x1",
];

/**
 * The tier the typical pack is estimated on. The free tier's estimate holds
 * only still images, which is what a pack delivers today (video is coming
 * soon), so the number stays true for every plan.
 */
const STILLS_ESTIMATE_TIER: TierKey = "free";

/** Credits a default Listing Mode pack of still images uses. */
export function typicalPackCredits(): number {
  return estimatePackCredits([...TYPICAL_PACK_CHANNELS], "listing", STILLS_ESTIMATE_TIER).total;
}

/** How many typical packs a credit amount covers, rounded down. */
export function packsForCredits(credits: number): number {
  const perPack = typicalPackCredits();
  return perPack > 0 ? Math.floor(credits / perPack) : 0;
}

/** The one time free plan grant. */
export function freeCredits(): number {
  return tierByKey("free").creditsOnce;
}

/** "0.5 credit", "1 credit", "3 credits". */
export function formatCredits(credits: number): string {
  return `${credits} ${credits > 1 ? "credits" : "credit"}`;
}

/** Display name for a tier key, for example "starter" to "Starter". */
export function tierDisplayName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Paid plans, in seed order. */
export function paidTiers() {
  return tiers.filter((tier) => tier.monthlyUsd > 0);
}

/**
 * The real annual saving across paid plans, each rounded down to a whole
 * percent so the claim never overstates the seed prices.
 */
export function annualSavingsPercentRange(): { min: number; max: number } {
  const savings = paidTiers()
    .filter((tier) => tier.annualUsdPerMonth > 0)
    .map((tier) => Math.floor(((tier.monthlyUsd - tier.annualUsdPerMonth) / tier.monthlyUsd) * 100));
  if (savings.length === 0) {
    return { min: 0, max: 0 };
  }
  return { min: Math.min(...savings), max: Math.max(...savings) };
}

/** "16 to 17 percent", or "17 percent" when every plan saves the same. */
export function annualSavingsPhrase(): string {
  const { min, max } = annualSavingsPercentRange();
  return min === max ? `${min} percent` : `${min} to ${max} percent`;
}

/** Months a bought top up stays usable (the shortest across top up packs). */
export function topUpMonths(): number {
  return Math.min(...topUps.map((topUp) => topUp.expiresMonths));
}

/** Plain sentence for the rollover policy in the seed. */
export function rolloverSentence(): string {
  const cycles =
    rolloverPolicy.cycles === 1 ? "the next billing cycle" : `the next ${rolloverPolicy.cycles} billing cycles`;
  const factor = rolloverPolicy.capFactorOfMonthlyAllowance;
  const cap = factor === 1 ? "one month" : `${factor} months`;
  return `Unused subscription credits carry over to ${cycles}, up to ${cap} of your allowance.`;
}

/** "enough for a full listing pack of stills", computed from the seeds. */
export function freeCreditsReach(): string {
  const packs = packsForCredits(freeCredits());
  if (packs >= 2) {
    return `enough for ${packs} full listing packs of still images`;
  }
  if (packs === 1) {
    return "enough for a full listing pack of still images";
  }
  return "enough to try a compliant main image and lifestyle scenes";
}

// Amazon main image rules, from the spec registry.

function percent(share: number): number {
  return Math.round(share * 1000) / 10;
}

export function amazonMainRules() {
  const spec = getSpec("amazon.main");
  const fill = spec.fill ?? { min: 0, max: 1 };
  const rgb = spec.background?.rgb ?? [255, 255, 255];
  return {
    fillMinPercent: percent(fill.min),
    fillMaxPercent: percent(fill.max),
    minLongSide: spec.minLongSide ?? 0,
    width: spec.width ?? spec.minLongSide ?? 0,
    height: spec.height ?? spec.minLongSide ?? 0,
    rgb,
  };
}

// Features

export interface Feature {
  label: string;
  status: Availability;
  /**
   * How copy refers to the feature. While the feature is coming soon, any
   * sentence that matches must also say "coming soon" (see
   * unqualifiedClaims), so a flag flip is the only change needed to sell it.
   */
  mentions?: RegExp;
}

export const FEATURES = {
  fidelityLock: { label: "Product pixels never regenerated", status: "live" },
  whiteMainImage: { label: "Pure white main images", status: "live" },
  lifestyleScenes: { label: "Lifestyle scenes around the real product", status: "live" },
  complianceReport: { label: "Measured compliance report", status: "live" },
  brandKitColors: { label: "Brand kit colors in packs", status: "live" },
  freeTools: { label: "Free browser tools", status: "live" },
  video: { label: "Product and social video", status: "coming_soon", mentions: /\bvideos?\b/i },
  directPublishing: {
    label: "Publishing straight to Shopify",
    status: "coming_soon",
    mentions: /\bpublish/i,
  },
  shopifyAutoPacks: {
    label: "Automatic packs for new Shopify products",
    status: "coming_soon",
    mentions: /\bauto(matic)? packs?\b/i,
  },
  freshCreativeDrop: {
    label: "Fresh Creative Drop",
    status: "coming_soon",
    mentions: /Fresh Creative Drop|every Monday/i,
  },
  seasonalCalendar: {
    label: "Season calendar",
    status: "coming_soon",
    mentions: /season(al)? calendar|Prime Day|Black Friday/i,
  },
  ugcAds: { label: "UGC hook ads", status: "coming_soon", mentions: /\bUGC\b|\bavatar/i },
  priorityQueue: { label: "Priority queue", status: "coming_soon", mentions: /priority queue/i },
  multipleBrandKits: {
    label: "More than one brand kit",
    status: "coming_soon",
    mentions: /\bbrand kits\b/i,
  },
  brandKitExtras: {
    label: "Brand kit fonts, logo and scene styles in packs",
    status: "coming_soon",
    mentions: /\bfonts?\b|\blogo\b|scene styles?/i,
  },
  agencyWorkspaces: {
    label: "Client workspaces for agencies",
    status: "coming_soon",
    mentions: /client workspaces?/i,
  },
  reviewLinks: { label: "Client review links", status: "coming_soon", mentions: /review links?/i },
  whiteLabel: { label: "White label share pages", status: "coming_soon", mentions: /white label/i },
  textCheck: {
    label: "Measured text checks",
    status: "coming_soon",
    mentions: /text policy|text and props|no text detected|text check/i,
  },
  sharePages: {
    label: "Share pages for finished packs",
    status: "coming_soon",
    mentions: /share (pages?|links?)|share this makeover/i,
  },
  urlImport: {
    label: "Import a product from its URL",
    status: "coming_soon",
    mentions: /product URL|paste a (product )?(URL|link)/i,
  },
} as const satisfies Record<string, Feature>;

export type FeatureKey = keyof typeof FEATURES;

export function isLive(key: FeatureKey): boolean {
  return FEATURES[key].status === "live";
}

export function comingSoonFeatures(): Feature[] {
  return Object.values(FEATURES as Record<string, Feature>).filter((feature) => feature.status === "coming_soon");
}

// Channels

export interface ChannelFamily {
  /** The spec id prefix, for example "amazon" for "amazon.main". */
  family: string;
  name: string;
  status: Availability;
}

/**
 * Which marketplace and social channels a pack delivers files for today.
 * The spec registry describes more channels than the planner fills, so this
 * list, not the registry, decides what copy may promise. A test plans a
 * pack with every channel selected and fails when this drifts.
 */
export const CHANNEL_FAMILIES: readonly ChannelFamily[] = [
  { family: "amazon", name: "Amazon", status: "live" },
  { family: "shopify", name: "Shopify", status: "live" },
  { family: "google", name: "Google Merchant", status: "live" },
  { family: "meta", name: "Meta", status: "live" },
  { family: "walmart", name: "Walmart", status: "coming_soon" },
  { family: "etsy", name: "Etsy", status: "coming_soon" },
  { family: "ebay", name: "eBay", status: "coming_soon" },
  { family: "tiktokshop", name: "TikTok Shop", status: "coming_soon" },
  { family: "pinterest", name: "Pinterest", status: "coming_soon" },
];

export function familyOf(specId: string): string {
  return specId.split(".")[0] ?? specId;
}

/** Image channel families in the registry, for the drift test. */
export function registryImageFamilies(): string[] {
  return [...new Set(listSpecs().map((spec) => familyOf(spec.id)).filter((family) => family !== "video"))];
}

export function liveChannelNames(): string[] {
  return CHANNEL_FAMILIES.filter((channel) => channel.status === "live").map((channel) => channel.name);
}

export function comingSoonChannelNames(): string[] {
  return CHANNEL_FAMILIES.filter((channel) => channel.status === "coming_soon").map((channel) => channel.name);
}

const comingSoonChannelPattern = (): RegExp | null => {
  const names = comingSoonChannelNames();
  return names.length > 0 ? new RegExp(`\\b(${names.join("|")})\\b`, "i") : null;
};

/** "A, B and C". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Sentences that mention a feature or channel which is not live, without
 * saying it is coming soon. Copy that sells only what runs returns [].
 */
export function unqualifiedClaims(text: string): string[] {
  const patterns = comingSoonFeatures()
    .map((feature) => feature.mentions)
    .filter((pattern): pattern is RegExp => pattern !== undefined);
  const channels = comingSoonChannelPattern();
  if (channels) {
    patterns.push(channels);
  }
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .filter((sentence) => patterns.some((pattern) => pattern.test(sentence)))
    .filter((sentence) => !/coming soon/i.test(sentence));
}
