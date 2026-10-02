/**
 * The main image checker's channels (docs/phases/PHASE_18.md P18-10). Which
 * specs the checker offers is seeded (mainImageCheckerSpecIds in
 * packages/pipeline/src/seed/growth.ts); every threshold comes from that
 * spec's registry entry (CLAUDE.md rule 2), and a spec shows only while the
 * registry marks it verified, so an unchecked rule is never used to fail a
 * seller's photo. The browser checker, the store image audit (P18-18) and
 * the requirement pages all read their rules here.
 */

import { getSpec, hasSpec, type ChannelSpec } from "@curvi/specs";
import { mainImageCheckerSpecIds } from "@curvi/pipeline/seed";
import { specSlug } from "@/components/marketing/spec-slug";
import { channelName, familyOf } from "@/lib/marketing-facts";
import type { CheckerRules } from "./main-image-analysis";

export const MAIN_IMAGE_CHECKER_PATH = "/tools/main-image-checker";

export interface CheckerChannel {
  /** The spec's family, for example "google": the ?channel= value and the tool_checker_<key> signup source. */
  key: string;
  specId: string;
  /** "Google Merchant". */
  name: string;
  /** The channel's requirements page, which the checker links back to. */
  requirementsPath: string;
  rules: CheckerRules;
}

function percent(share: number): number {
  return Math.round(share * 1000) / 10;
}

/**
 * The checker rules a registry spec gives, or null when the spec is not
 * verified or asks for no white background (the checker measures white
 * main images only).
 */
export function checkerRulesFromSpec(spec: ChannelSpec): CheckerRules | null {
  if (!spec.verified) {
    return null;
  }
  const bg = spec.background;
  let background: NonNullable<CheckerRules["background"]>;
  if (bg?.type === "solid" && bg.rgb?.every((value) => value === 255)) {
    background = "white";
  } else if (bg?.type === "white_preferred") {
    background = "white";
  } else if (bg?.type === "white_or_transparent") {
    background = "white_or_transparent";
  } else {
    return null;
  }
  return {
    minLongSide: spec.minLongSide ?? 0,
    ...(spec.minWidth ? { minWidth: spec.minWidth } : {}),
    ...(spec.minHeight ? { minHeight: spec.minHeight } : {}),
    fillMinPercent: spec.fill ? percent(spec.fill.min) : null,
    fillMaxPercent: spec.fill ? percent(spec.fill.max) : null,
    background,
  };
}

/** The channels the checker offers today, in the seeded order, Amazon first. */
export function checkerChannels(): CheckerChannel[] {
  return mainImageCheckerSpecIds.flatMap((specId) => {
    if (!hasSpec(specId)) {
      return [];
    }
    const rules = checkerRulesFromSpec(getSpec(specId));
    if (!rules) {
      return [];
    }
    const key = familyOf(specId);
    return [
      {
        key,
        specId,
        name: channelName(key),
        requirementsPath: `/channels/${specSlug(specId)}/image-requirements`,
        rules,
      },
    ];
  });
}

/** The default channel: the first one offered (Amazon). */
export function defaultCheckerChannel(): CheckerChannel {
  const first = checkerChannels()[0];
  if (!first) {
    throw new Error("The main image checker has no verified channel spec");
  }
  return first;
}

/** The channel a ?channel= value names, or the default for anything else. */
export function checkerChannelFor(raw: unknown): CheckerChannel {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return checkerChannels().find((channel) => channel.key === value) ?? defaultCheckerChannel();
}

/** The checker channel for a spec id, when the checker offers that spec. */
export function checkerChannelForSpec(specId: string): CheckerChannel | undefined {
  return checkerChannels().find((channel) => channel.specId === specId);
}

/** The checker page with a channel preset. */
export function checkerPagePath(key: string): string {
  return `${MAIN_IMAGE_CHECKER_PATH}?channel=${encodeURIComponent(key)}`;
}
