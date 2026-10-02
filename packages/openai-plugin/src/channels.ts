/**
 * The listing lines that name channels, generated from the web app's live
 * channel list (apps/web/src/lib/marketing-facts.ts, CHANNEL_FAMILIES) and
 * the spec registry's marketplace split (founder decision 17, rule 2). The
 * build refuses a manifest whose lines differ from these, or that names a
 * channel a pack does not make today, so the listing never sells a channel
 * that is not live.
 */

import { isMarketplaceChannel } from "@curvi/specs";
import { CHANNEL_FAMILIES } from "@/lib/marketing-facts";

export interface ChannelFamilyFact {
  family: string;
  name: string;
  status: "live" | "coming_soon";
}

/** The live channel list, as the web app states it. */
export function liveChannelFamilies(): readonly ChannelFamilyFact[] {
  return CHANNEL_FAMILIES;
}

/** "A, B and C" (or "A, B or C"). */
export function joinNames(names: readonly string[], last: "and" | "or" = "and"): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} ${last} ${names[names.length - 1]}`;
}

export interface ChannelGroups {
  /** Live store and marketplace channels, in the web app's order. */
  marketplaces: string[];
  /** Live ad channels. */
  ads: string[];
}

/** The live channels, split into marketplaces and ad placements by the spec
 * registry. */
export function channelGroups(families: readonly ChannelFamilyFact[]): ChannelGroups {
  const live = families.filter((family) => family.status === "live");
  return {
    marketplaces: live.filter((family) => isMarketplaceChannel(family.family)).map((family) => family.name),
    ads: live.filter((family) => !isMarketplaceChannel(family.family)).map((family) => family.name),
  };
}

export interface ChannelListingLines {
  /** Capability lines the manifest must carry word for word. */
  capabilities: string[];
  /** A phrase longDescription must carry word for word. */
  longDescription: string;
}

export function channelListingLines(families: readonly ChannelFamilyFact[]): ChannelListingLines {
  const { marketplaces, ads } = channelGroups(families);
  return {
    capabilities: [
      ...(marketplaces.length > 0 ? [`Sizes images for ${joinNames(marketplaces)}`] : []),
      ...(ads.length > 0 ? [`Makes ad images for ${joinNames(ads)} placements`] : []),
    ],
    longDescription: `say where you sell or advertise: ${joinNames([...marketplaces, ...ads], "or")}.`,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Channel names in the text that a pack does not make today. */
export function notLiveChannelNames(text: string, families: readonly ChannelFamilyFact[]): string[] {
  const live = families.filter((family) => family.status === "live").map((family) => family.name);
  return families
    .filter((family) => family.status !== "live")
    .map((family) => family.name)
    // "TikTok" is part of "TikTok Shop": a name counts only where no live
    // name that contains it covers the match.
    .filter((name) => {
      const longer = live.filter((other) => other !== name && other.includes(name));
      const stripped = longer.reduce((rest, other) => rest.replace(new RegExp(escapeRegExp(other), "g"), " "), text);
      return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(stripped);
    });
}
