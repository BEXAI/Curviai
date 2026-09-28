import type { ChannelSpec } from "@curvi/specs";
import {
  joinList,
  liveChannelNames,
  specAvailability,
  specFilesNameFor,
  type Availability,
} from "@/lib/marketing-facts";
import { specDisplayName } from "./spec-slug";

/**
 * Copy for a channel requirements page. A spec the pipeline makes files for
 * is sold as built and measured; any other spec keeps its rules table but
 * says its files are coming soon and points to what works today, so the
 * page never promises a file Curvi does not make (Phase 10 decision 1).
 */
export interface ChannelPageCopy {
  status: Availability;
  intro: string;
  ctaTitle: string;
  ctaBody: string;
}

function verificationNote(spec: ChannelSpec): string {
  return spec.verified
    ? "This spec is tracked against official documentation."
    : "This spec is compiled from public guidance and is pending verification against official documentation.";
}

export function channelPageCopy(spec: ChannelSpec): ChannelPageCopy {
  const files = specFilesNameFor(spec.id) ?? specDisplayName(spec.id);
  if (specAvailability(spec.id) === "live") {
    return {
      status: "live",
      intro: `Curvi builds ${files} to the rules below, then measures the output pixels against the size, background and fill rules before a file ships. ${verificationNote(spec)}`,
      ctaTitle: "Built to this spec from one photo",
      ctaBody: `Curvi builds ${files} from one photo of your product, measures the output pixels and attaches the report. A file that still fails a check after a retry is marked for review, and you are not charged for it.`,
    };
  }
  return {
    status: "coming_soon",
    intro: `${files} from Curvi are coming soon. Until then, use the rules below to check your own images. ${verificationNote(spec)}`,
    ctaTitle: `${files} are coming soon`,
    ctaBody: `Today a pack makes files for ${joinList(liveChannelNames())}. You can start free with those, or check your current main image with the free checker.`,
  };
}
