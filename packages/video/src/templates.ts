import { hasSpec } from "@curvi/specs";
import type { VideoFormat } from "./remotion/schemas";

export const templateCompositionIds = [
  "Spin360",
  "Slideshow",
  "FeatureCallouts",
  "DimensionReveal",
] as const;

export type TemplateCompositionId = (typeof templateCompositionIds)[number];

export interface VideoTemplateDescriptor {
  /** Stable id the planner stores on a shot. */
  id: string;
  /** Composition id registered in src/remotion/Root.tsx. */
  compositionId: TemplateCompositionId;
  /** Lookup key into the credits pricing table. No prices live here. */
  creditsKey: string;
  /** Channel specs this template can render for, validated against @curvi/specs. */
  targetSpecIds: readonly string[];
  /** Canvas variants the composition supports through its props. */
  formats: readonly VideoFormat[];
  /** Plain spoken summary for the planner and the UI. */
  summary: string;
}

export const videoTemplates: readonly VideoTemplateDescriptor[] = [
  {
    id: "spin360",
    compositionId: "Spin360",
    creditsKey: "video.template.spin360",
    targetSpecIds: ["video.social_9x16", "video.amazon_listing"],
    formats: ["9x16", "1x1"],
    summary: "Turntable style spin built from the seller's own angle photos.",
  },
  {
    id: "slideshow",
    compositionId: "Slideshow",
    creditsKey: "video.template.slideshow",
    targetSpecIds: ["video.social_9x16", "video.amazon_listing"],
    formats: ["9x16", "1x1"],
    summary: "Stills with captions and simple slide transitions.",
  },
  {
    id: "feature_callouts",
    compositionId: "FeatureCallouts",
    creditsKey: "video.template.feature_callouts",
    targetSpecIds: ["video.social_9x16", "video.amazon_listing"],
    formats: ["9x16", "1x1"],
    summary: "One hero still with three to five feature labels that spring in.",
  },
  {
    id: "dimension_reveal",
    compositionId: "DimensionReveal",
    creditsKey: "video.template.dimension_reveal",
    targetSpecIds: ["video.social_9x16", "video.amazon_listing"],
    formats: ["9x16", "1x1"],
    summary: "A product still with animated measurement lines and size labels.",
  },
];

export function listVideoTemplates(): readonly VideoTemplateDescriptor[] {
  return videoTemplates;
}

export function getVideoTemplate(id: string): VideoTemplateDescriptor {
  const template = videoTemplates.find((entry) => entry.id === id);
  if (!template) {
    throw new Error(`Unknown video template: ${id}`);
  }
  return template;
}

/** Throws when any template points at a channel spec the registry lacks. */
export function assertTemplateSpecsExist(): void {
  for (const template of videoTemplates) {
    for (const specId of template.targetSpecIds) {
      if (!hasSpec(specId)) {
        throw new Error(`Template ${template.id} references missing channel spec ${specId}`);
      }
    }
  }
}
