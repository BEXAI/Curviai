/**
 * Server side plan entitlement checks. What each tier includes, and whether
 * a feature ships today, lives in the seed (packages/pipeline/src/seed/
 * credits.ts, CLAUDE.md rule 2); this module turns it into decisions for the
 * app. A feature that is not live is refused for every tier with a Coming
 * soon message, so nobody pays for or waits on output that cannot ship
 * (Phase 10 decision 1). A live feature outside the plan asks for an upgrade.
 *
 * The new pack form reads the same decisions through channelAvailability,
 * so it never offers a channel that createJob would refuse.
 */

import {
  channelFamilyFeatures,
  entitlementsFor,
  isEntitled,
  isFeatureLive,
  lowestTierWith,
  tiers,
  type TierFeature,
  type TierKey,
} from "@curvi/pipeline/seed";

/** Maps a workspaces.plan value to a tier key; unknown plans read as free. */
export function tierKeyOf(plan: string | null | undefined): TierKey {
  const match = tiers.find((t) => t.key === plan);
  return match ? match.key : "free";
}

export type EntitlementCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "feature_unavailable" | "upgrade_required";
      feature: TierFeature;
      /** The cheapest plan that includes the feature, when one does. */
      upgradeTo: TierKey | null;
      message: string;
    };

const FEATURE_NAMES: Record<string, string> = {
  video: "Video",
};

function familyOf(channel: string): string {
  return channel.split(".")[0] ?? channel;
}

/** "growth" reads as "Growth" in copy. */
export function tierName(key: TierKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Checks the channels a pack asks for against the plan. Channel families that
 * only carry a plan feature (video today) need at least one of their features
 * to be live and included in the tier. isLive defaults to the seed status.
 */
export function checkChannelEntitlements(
  channels: string[],
  tier: TierKey,
  isLive: (feature: TierFeature) => boolean = isFeatureLive,
): EntitlementCheck {
  const families = [...new Set(channels.map(familyOf))];
  for (const family of families) {
    const features = channelFamilyFeatures[family];
    if (!features || features.length === 0) {
      continue;
    }
    const name = FEATURE_NAMES[family] ?? family;
    const live = features.filter((feature) => isLive(feature));
    if (live.length === 0) {
      return {
        ok: false,
        reason: "feature_unavailable",
        feature: features[0],
        upgradeTo: null,
        message: `${name} is coming soon, so ${name.toLowerCase()} channels cannot be added to a pack yet. Remove them to start this pack.`,
      };
    }
    if (!live.some((feature) => isEntitled(tier, feature))) {
      const cheapest = live
        .map((feature) => lowestTierWith(feature))
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .sort((a, b) => a.monthlyUsd - b.monthlyUsd)[0];
      return {
        ok: false,
        reason: "upgrade_required",
        feature: live[0],
        upgradeTo: cheapest?.key ?? null,
        message: cheapest
          ? `${name} comes with the ${tierName(cheapest.key)} plan and above. Upgrade, or remove the ${name.toLowerCase()} channels to start this pack.`
          : `${name} is not part of your plan. Remove the ${name.toLowerCase()} channels to start this pack.`,
      };
    }
  }
  return { ok: true };
}

/** Whether the new pack form may offer a channel, and why not. */
export type ChannelAvailability =
  | { status: "available" }
  /** The channel's feature does not ship yet on any plan. */
  | { status: "coming_soon" }
  /** The feature ships, but not on this plan; upgradeTo is the cheapest plan with it. */
  | { status: "upgrade_required"; upgradeTo: TierKey | null };

/**
 * One channel judged exactly as createJob judges a pack: a channel is only
 * offered when a pack holding it would pass checkChannelEntitlements.
 */
export function channelAvailability(
  channel: string,
  tier: TierKey,
  isLive: (feature: TierFeature) => boolean = isFeatureLive,
): ChannelAvailability {
  const check = checkChannelEntitlements([channel], tier, isLive);
  if (check.ok) {
    return { status: "available" };
  }
  return check.reason === "feature_unavailable"
    ? { status: "coming_soon" }
    : { status: "upgrade_required", upgradeTo: check.upgradeTo };
}

export type BrandKitCheck = { ok: true } | { ok: false; reason: "upgrade_required"; message: string };

/**
 * Brand kits a workspace may hold come from the seed (entitlementsFor(tier)
 * .brandKits: none on Free). Saving changes to a kit the workspace already
 * holds needs a plan with at least one kit; creating one needs room under
 * the plan's count.
 */
export function checkBrandKitEntitlement(tier: TierKey, kitsHeld: number, creating: boolean): BrandKitCheck {
  const allowed = entitlementsFor(tier).brandKits;
  const fits = creating ? kitsHeld < allowed : allowed > 0;
  if (fits) {
    return { ok: true };
  }
  if (allowed === 0) {
    const cheapest = tiers.find((t) => entitlementsFor(t.key).brandKits > 0);
    return {
      ok: false,
      reason: "upgrade_required",
      message: cheapest
        ? `Brand kits come with the ${tierName(cheapest.key)} plan and above. Upgrade on the billing page to save one.`
        : "Brand kits are not part of your plan.",
    };
  }
  return {
    ok: false,
    reason: "upgrade_required",
    message: `Your plan includes ${allowed} brand ${allowed === 1 ? "kit" : "kits"} and this workspace already has ${allowed === 1 ? "it" : "them"}. Edit the kit you have instead.`,
  };
}
