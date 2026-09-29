/**
 * The channel list the new pack form shows. Every channel comes from the
 * spec registry, and each one carries the verdict createJob would give it
 * (lib/entitlements.ts), so the form marks as Coming soon a channel whose
 * plan feature is not live (from the seed) or whose spec a pack makes no
 * files for yet (lib/marketing-facts isSpecLive, for example
 * amazon.aplus.premium_full), marks one outside the plan as an upgrade, and
 * never lets either be picked (Phase 10 decision 1). The server check stays
 * in createJob; this only keeps the form from offering what it refuses.
 *
 * Each option also carries the registry facts the form's chips read
 * (PHASE_15 control 4): whether the spec stays white whatever the color,
 * and its size when width by height is the only size it takes.
 */

import type { TierFeature, TierKey } from "@curvi/pipeline/seed";
import { isFeatureLive } from "@curvi/pipeline/seed";
import { isExactSize, isMarketplaceSpec, listSpecs, requiresWhiteBackground } from "@curvi/specs";
import type { ChannelOption } from "@/components/app/new-pack-form";
import { channelAvailability } from "@/lib/entitlements";
import { isSpecLive } from "@/lib/marketing-facts";

export function newPackChannelOptions(
  tier: TierKey,
  isLive: (feature: TierFeature) => boolean = isFeatureLive,
  specLive: (specId: string) => boolean = isSpecLive,
): ChannelOption[] {
  return listSpecs().map((spec) => {
    const availability = channelAvailability(spec.id, tier, isLive, specLive);
    return {
      id: spec.id,
      marketplace: isMarketplaceSpec(spec.id),
      availability: availability.status,
      upgradeTo: availability.status === "upgrade_required" ? availability.upgradeTo : null,
      requiresWhite: requiresWhiteBackground(spec),
      exactSize:
        isExactSize(spec) && spec.width !== undefined && spec.height !== undefined
          ? { width: spec.width, height: spec.height }
          : null,
    };
  });
}
