/**
 * The product as the live generator hands it to every still renderer: the
 * Photoroom cutout of the seller's real photo and its mask, decoded and
 * encoded once per source photo. Renderers only move, scale and place these
 * pixels; nothing regenerates them (CLAUDE.md rule 3).
 */

import type { RawImage, RawMask } from "@curvi/pipeline";
import type { QcErosion } from "./shot-outputs";

export interface LiveProduct {
  /** Cutout RGBA at the cutout's native size (alpha 0 outside the product). */
  productRgba: RawImage;
  /** Binary mask at the same size: 255 on the product, 0 elsewhere. */
  mask: RawMask;
  /** productRgba encoded as PNG, for helpers that take encoded buffers. */
  productPng: Buffer;
  /** mask encoded as a single channel PNG, same size as productPng. */
  maskPng: Buffer;
}

/** What a still renderer returns; the live generator adds cost and caps. */
export interface StillRender {
  /** Final canvas, raw RGBA at the channel spec's size. */
  image: RawImage;
  /** Product placement mask at canvas scale, for fill and background QC. */
  mask: RawMask | null;
  /** The encoded file that ships, in a format the channel spec allows. */
  encoded: { buffer: Buffer; format: string };
  /**
   * Rule 3 reference at canvas size: the input cutout only cropped and
   * scaled to where the renderer placed it, with no background, shadow,
   * text, color change or encoding. fidelityReport(productReference, image,
   * mask) proves the shipped product pixels were not regenerated.
   */
  productReference: RawImage;
  /**
   * Fidelity check region the encoding was verified with: the erosion the
   * runner must apply to the mask, and the lowest it may go when the image is
   * re-framed. Thin products get a smaller erosion instead of an empty region.
   */
  fidelityErosion?: QcErosion;
}
