/**
 * Server side plan entitlement checks. What each tier includes, and whether
 * a feature ships today, lives in the seed (packages/pipeline/src/seed/
 * credits.ts, CLAUDE.md rule 2); this module turns it into decisions for the
 * app. A feature that is not live is refused for every tier with a Coming
 * soon message, so nobody pays for or waits on output that cannot ship
 * (Phase 10 decision 1). A live feature outside the plan asks for an upgrade.
 */

import {
  channelFamilyFeatures,
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
      message: string;
    };

const FEATURE_NAMES: Record<string, string> = {
  video: "Video",
};

function familyOf(channel: string): string {
  return channel.split(".")[0] ?? channel;
}

function tierName(key: TierKey): string {
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
        message: cheapest
          ? `${name} comes with the ${tierName(cheapest.key)} plan and above. Upgrade, or remove the ${name.toLowerCase()} channels to start this pack.`
          : `${name} is not part of your plan. Remove the ${name.toLowerCase()} channels to start this pack.`,
      };
    }
  }
  return { ok: true };
}
