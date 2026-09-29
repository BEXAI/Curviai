/**
 * Picking which versions of a lifestyle scene ship (docs/phases/PHASE_16.md
 * workstream 6, founder decision 3). The pack makes each scene in the
 * versions the seller asked for; the scene itself ships and every extra
 * version waits unpicked (asset_variants.picked false) until the seller
 * picks it on the job page. Pure, so the rules are unit tested without a
 * database:
 *
 * - which cards are versions of one scene, and which version each is;
 * - whether picking a version would put a channel past its file limit
 *   (amazon.secondary takes 8), which is refused rather than shipping a
 *   pack the channel turns down.
 */

import { parseVariationShotId } from "@curvi/pipeline/variations";
import { channelFileLimit, getSpec, hasSpec } from "@curvi/specs";
import { channelName } from "@/lib/output-options-copy";
import type { ShotVersionView } from "@/lib/services/types";

/**
 * The version of every card that belongs to a scene made in more than one
 * version, by shot id. The scene itself is version 1; a card whose picked
 * state is unknown reads as picked for the scene and unpicked for an extra
 * version, the way the pack stored them.
 */
export function shotVersionsOf(
  shotIds: readonly string[],
  pickedOf: (shotId: string) => boolean | undefined,
): Map<string, ShotVersionView> {
  const extras = new Map<string, Array<{ shotId: string; number: number }>>();
  for (const shotId of shotIds) {
    const parsed = parseVariationShotId(shotId);
    if (parsed) {
      extras.set(parsed.baseShotId, [...(extras.get(parsed.baseShotId) ?? []), { shotId, number: parsed.variation }]);
    }
  }
  const out = new Map<string, ShotVersionView>();
  for (const [scene, versions] of extras) {
    out.set(scene, { number: 1, sceneShotId: scene, picked: pickedOf(scene) ?? true });
    for (const version of versions) {
      out.set(version.shotId, { number: version.number, sceneShotId: scene, picked: pickedOf(version.shotId) ?? false });
    }
  }
  return out;
}

/**
 * The first spec picking these files would put past its file limit, or
 * null when every spec has room. pickedOnSpec counts the files already
 * picked on each spec in the pack, not counting the files being picked.
 */
export function overLimitSpec(specIds: readonly string[], pickedOnSpec: ReadonlyMap<string, number>): string | null {
  const adding = new Map<string, number>();
  for (const specId of specIds) {
    adding.set(specId, (adding.get(specId) ?? 0) + 1);
  }
  for (const [specId, count] of adding) {
    const limit = hasSpec(specId) ? channelFileLimit(getSpec(specId)) : null;
    if (limit !== null && (pickedOnSpec.get(specId) ?? 0) + count > limit) {
      return specId;
    }
  }
  return null;
}

export const VERSION_COPY = {
  label: (n: number) => `Version ${n}`,
  picked: "In your files",
  notPicked: "Not in your files",
  pick: "Use this version",
  unpick: "Leave this version out",
  picking: "Saving",
  saved: (picked: boolean) =>
    picked ? "This version is now in your files." : "This version is no longer in your files.",
  channelFull: (specId: string) =>
    `${channelName(specId)} has no room for another image. Leave another version out first.`,
  notReady: "You can pick versions once the pack is finished.",
  notAVersion: "Only scenes made in more than one version can be picked.",
  failed: "We could not save that. Try again.",
} as const;

export const FAVORITE_COPY = {
  add: "Add to favorites",
  remove: "Remove from favorites",
  failed: "We could not save that favorite. Try again.",
} as const;
