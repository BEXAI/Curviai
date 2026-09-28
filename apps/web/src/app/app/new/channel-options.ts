/**
 * The channel list the new pack form shows. Every channel comes from the
 * spec registry, and each one carries the verdict createJob would give it
 * (lib/entitlements.ts, from the seed), so the form marks a channel whose
 * feature is not live as Coming soon and one outside the plan as an upgrade,
 * and never lets either be picked (Phase 10 decision 1). The server check
 * stays in createJob; this only keeps the form from offering what it refuses.
 */

import type { TierFeature, TierKey } from "@curvi/pipeline/seed";
import { isFeatureLive } from "@curvi/pipeline/seed";
import { isMarketplaceSpec, listSpecs } from "@curvi/specs";
import type { ChannelOption } from "@/components/app/new-pack-form";
import { channelAvailability } from "@/lib/entitlements";

export function newPackChannelOptions(
  tier: TierKey,
  isLive: (feature: TierFeature) => boolean = isFeatureLive,
): ChannelOption[] {
  return listSpecs().map((spec) => {
    const availability = channelAvailability(spec.id, tier, isLive);
    return {
      id: spec.id,
      marketplace: isMarketplaceSpec(spec.id),
      availability: availability.status,
      upgradeTo: availability.status === "upgrade_required" ? availability.upgradeTo : null,
    };
  });
}
