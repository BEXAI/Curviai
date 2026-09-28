import { getSpec, listSpecs } from "@curvi/specs";
import { tierByKey, tiers, topUps, type TierKey } from "@curvi/pipeline/seed";
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

/**
 * What happens to credits a plan does not use, the one line /pricing,
 * /app/billing and help all show. Subscription grants never expire (the
 * webhook writes them with no expiry), so there is no cap to state. The seed
 * rolloverPolicy is not enforced anywhere; promise a cap only in the change
 * that enforces it, capped by months paid so annual plans keep their year.
 */
export const UNUSED_CREDITS_SENTENCE =
  "Credits you do not use stay in your balance from one billing period to the next.";

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
    status: "live",
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
    status: "live",
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

export interface ChannelSpecAvailability {
  /** Spec id in the registry, for example "amazon.main". */
  specId: string;
  /** How lists name these files after the channel, for example "main images" in "Amazon main images". */
  files: string;
  status: Availability;
  /**
   * Wording that names this spec on its own. A coming soon spec whose
   * channel has other live specs needs one, so copy that mentions it
   * without saying coming soon is caught (see unqualifiedClaims).
   */
  mentions?: RegExp;
}

export interface ChannelFamily {
  /** The spec id prefix, for example "amazon" for "amazon.main". */
  family: string;
  name: string;
  status: Availability;
}

/** Channel names by spec id prefix, in the order copy lists them. */
const CHANNEL_NAMES: readonly { family: string; name: string }[] = [
  { family: "amazon", name: "Amazon" },
  { family: "shopify", name: "Shopify" },
  { family: "walmart", name: "Walmart" },
  { family: "etsy", name: "Etsy" },
  { family: "ebay", name: "eBay" },
  { family: "tiktokshop", name: "TikTok Shop" },
  { family: "google", name: "Google Merchant" },
  { family: "meta", name: "Meta" },
  { family: "pinterest", name: "Pinterest" },
];

/**
 * Which channel specs a pack makes files for today, spec by spec. The spec
 * registry describes more than the pipeline fills, so this list, not the
 * registry, decides what copy and the channel requirement pages may
 * promise. A test runs the planner and the runner's channel fitting for
 * each spec picked on its own and for every spec picked together, at the
 * credits the server reserves, and fails when a flag here drifts from what
 * ships. Flip a flag in the same change that ships or pulls the files.
 */
export const CHANNEL_SPECS: readonly ChannelSpecAvailability[] = [
  { specId: "amazon.main", files: "main images", status: "live" },
  { specId: "amazon.secondary", files: "secondary images", status: "live" },
  { specId: "amazon.aplus.basic_header", files: "A plus basic headers", status: "live" },
  {
    specId: "amazon.aplus.premium_full",
    files: "A plus premium modules",
    status: "coming_soon",
    mentions: /A plus premium/i,
  },
  { specId: "shopify.product", files: "product images", status: "live" },
  { specId: "shopify.hero_banner", files: "hero banners", status: "live" },
  { specId: "walmart.main", files: "main images", status: "live" },
  { specId: "etsy.listing", files: "listing images", status: "live" },
  { specId: "ebay.listing", files: "listing images", status: "live" },
  { specId: "tiktokshop.main", files: "main images", status: "live" },
  { specId: "google.merchant.main", files: "main images", status: "live" },
  { specId: "google.merchant.lifestyle", files: "lifestyle images", status: "live" },
  { specId: "meta.feed_1x1", files: "feed squares", status: "live" },
  { specId: "meta.feed_4x5", files: "feed portraits", status: "live" },
  { specId: "meta.story_9x16", files: "stories", status: "live" },
  { specId: "pinterest.pin", files: "pins", status: "live" },
];

export function familyOf(specId: string): string {
  return specId.split(".")[0] ?? specId;
}

/** Image spec ids in the registry, for the drift test. */
export function registryImageSpecIds(): string[] {
  return listSpecs()
    .map((spec) => spec.id)
    .filter((id) => familyOf(id) !== "video");
}

/** A spec missing from CHANNEL_SPECS counts as coming soon, so a new registry entry is never sold by default. */
export function specAvailability(specId: string): Availability {
  return CHANNEL_SPECS.find((spec) => spec.specId === specId)?.status ?? "coming_soon";
}

export function isSpecLive(specId: string): boolean {
  return specAvailability(specId) === "live";
}

/** "Amazon" for "amazon", the family itself when it has no name yet. */
export function channelName(family: string): string {
  return CHANNEL_NAMES.find((channel) => channel.family === family)?.name ?? family;
}

/** "Amazon A plus premium modules". */
export function specFilesName(spec: ChannelSpecAvailability): string {
  return `${channelName(familyOf(spec.specId))} ${spec.files}`;
}

/** Files name for a spec id, or undefined for a spec missing from CHANNEL_SPECS. */
export function specFilesNameFor(specId: string): string | undefined {
  const spec = CHANNEL_SPECS.find((entry) => entry.specId === specId);
  return spec ? specFilesName(spec) : undefined;
}

/** A channel is live when a pack makes files for at least one of its specs. */
export const CHANNEL_FAMILIES: readonly ChannelFamily[] = CHANNEL_NAMES.map(({ family, name }) => ({
  family,
  name,
  status: CHANNEL_SPECS.some((spec) => familyOf(spec.specId) === family && spec.status === "live")
    ? "live"
    : "coming_soon",
}));

export function liveChannelNames(): string[] {
  return CHANNEL_FAMILIES.filter((channel) => channel.status === "live").map((channel) => channel.name);
}

export function comingSoonChannelNames(): string[] {
  return CHANNEL_FAMILIES.filter((channel) => channel.status === "coming_soon").map((channel) => channel.name);
}

/** "Amazon, Shopify, Walmart, Etsy and more": the first live channels, for short lines such as the hero. */
export function liveChannelShortList(max = 4): string {
  const names = liveChannelNames();
  return names.length > max ? `${names.slice(0, max).join(", ")} and more` : joinList(names);
}

/**
 * The files a pack can include today, grouped by channel, for example
 * "Amazon main images and secondary images; and Meta feed squares".
 */
export function liveFilesPhrase(): string {
  const groups = CHANNEL_NAMES.flatMap(({ family, name }) => {
    const files = CHANNEL_SPECS.filter((spec) => familyOf(spec.specId) === family && spec.status === "live").map(
      (spec) => spec.files,
    );
    return files.length > 0 ? [`${name} ${joinList(files)}`] : [];
  });
  if (groups.length <= 1) {
    return groups.join("");
  }
  return `${groups.slice(0, -1).join("; ")}; and ${groups[groups.length - 1]}`;
}

/** Files that are on the way, for example "Amazon A plus premium modules". */
export function comingSoonFileNames(): string[] {
  return CHANNEL_SPECS.filter((spec) => spec.status === "coming_soon").map(specFilesName);
}

/**
 * "Amazon A plus premium modules and video formats are coming soon." for the
 * files on the way plus any extra items, or "" when nothing is.
 */
export function comingSoonFilesSentence(extra: readonly string[] = []): string {
  const items = [...comingSoonFileNames(), ...extra];
  return items.length > 0 ? `${joinList(items)} are coming soon.` : "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const comingSoonChannelPatterns = (): RegExp[] => {
  const names = comingSoonChannelNames();
  const patterns = names.length > 0 ? [new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\b`, "i")] : [];
  for (const spec of CHANNEL_SPECS) {
    if (spec.status === "coming_soon" && spec.mentions) {
      patterns.push(spec.mentions);
    }
  }
  return patterns;
};

/** "A, B and C". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Sentences that mention a feature, channel or channel file which is not
 * live, without saying it is coming soon. Copy that sells only what runs
 * returns [].
 */
export function unqualifiedClaims(text: string): string[] {
  const patterns = comingSoonFeatures()
    .map((feature) => feature.mentions)
    .filter((pattern): pattern is RegExp => pattern !== undefined);
  patterns.push(...comingSoonChannelPatterns());
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .filter((sentence) => patterns.some((pattern) => pattern.test(sentence)))
    .filter((sentence) => !/coming soon/i.test(sentence));
}
