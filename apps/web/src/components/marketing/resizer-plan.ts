/**
 * The free marketplace resizer's rules (docs/phases/PHASE_15.md P1, free
 * resizer alignment): the same rules a pack uses for a kept photo, from
 * @curvi/pipeline/output-options. A channel whose rule requires white is
 * never offered, since a resize cannot remove a background; every other
 * channel keeps the photo's shape where it allows it (originalFitFor) and
 * gets white added space only where it needs a set shape. Pure, so the
 * rules are tested without a canvas.
 */

import {
  canvasSizeFor,
  originalFitFor,
  originalScale,
  specAcceptsImage,
} from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import { upscaleLimitText } from "@/lib/output-options-copy";
import { specDisplayName } from "./spec-slug";

export interface ResizerSpecs {
  /** Channels a kept photo may ship on, in registry order. */
  usable: ChannelSpec[];
  /** Channels whose rule requires white: they need a pack. */
  needsPack: ChannelSpec[];
}

/** Splits the image specs into the ones the resizer serves and the white required ones. */
export function resizerSpecs(specs: readonly ChannelSpec[]): ResizerSpecs {
  return {
    usable: specs.filter((spec) => specAcceptsImage(spec, "original")),
    needsPack: specs.filter((spec) => requiresWhiteBackground(spec)),
  };
}

/** "Amazon main image needs the background removed. Make a pack to get one." */
export function resizerWhiteLine(specId: string): string {
  return `${specDisplayName(specId)} needs the background removed. Make a pack to get one.`;
}

/** A channel the photo is too small for, within the same enlarge cap a pack uses. */
export function resizerTooSmallLine(specId: string, photo: { width: number; height: number }): string {
  return `This photo is ${photo.width} by ${photo.height} pixels, too small for ${specDisplayName(specId)} without enlarging it more than ${upscaleLimitText()} times. Upload the original from your camera.`;
}

/** The size line under a channel before any photo is picked. */
export function resizerSizeLine(spec: ChannelSpec): string {
  if (originalFitFor(spec) === "pad") {
    const { width, height } = canvasSizeFor(spec);
    return `${width} by ${height} px`;
  }
  return "Keeps your photo's shape";
}

/** The white used for added space. */
export const RESIZER_PAD_HEX = stillStyle.whiteHex;

export interface ResizerLayout {
  canvasWidth: number;
  canvasHeight: number;
  /** Where the photo is drawn on the canvas. */
  drawX: number;
  drawY: number;
  drawWidth: number;
  drawHeight: number;
  /** White space is added around the photo. */
  padded: boolean;
  /** The photo cannot reach this channel's minimum size within the enlarge cap. */
  tooSmall: boolean;
}

/**
 * Where a photo goes on one channel, by the kept photo rules: auto keeps
 * the photo's shape at the scale originalScale gives; pad (exact size
 * channels) centers it on the channel's canvas, inside the safe zone.
 */
export function resizerLayout(spec: ChannelSpec, photo: { width: number; height: number }): ResizerLayout {
  const scale = originalScale(photo, spec);
  const tooSmall = scale.skip !== undefined;
  if (originalFitFor(spec) === "pad") {
    const canvas = canvasSizeFor(spec);
    const top = spec.safeZone?.top ?? 0;
    const bottom = spec.safeZone?.bottom ?? 0;
    const safeHeight = Math.max(1, canvas.height - top - bottom);
    return {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      drawX: Math.round((canvas.width - scale.width) / 2),
      drawY: Math.round(top + (safeHeight - scale.height) / 2),
      drawWidth: scale.width,
      drawHeight: scale.height,
      padded: true,
      tooSmall,
    };
  }
  return {
    canvasWidth: scale.width,
    canvasHeight: scale.height,
    drawX: 0,
    drawY: 0,
    drawWidth: scale.width,
    drawHeight: scale.height,
    padded: false,
    tooSmall,
  };
}
