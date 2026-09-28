/**
 * Live renderers for the deterministic shot types (CURVI_BUILD_PLAN.md
 * section 5.7). Every output is built from the seller's real product cutout
 * with the whiten helpers in @curvi/pipeline: product pixels are only moved
 * and scaled, never recolored or regenerated (CLAUDE.md rule 3). Colors come
 * from the stillStyle seed and the channel spec, never from literals here.
 *
 * The returned image is always the decoded pixels of the encoded file that
 * ships, so the runner's pixelChecks measures exactly what the seller gets.
 */

import {
  boundingBoxOfMask,
  buildProductReference,
  decodeMask,
  decodeToRgba,
  encodePng,
  makeAmazonMain,
  makeCutoutPng,
  makeSweep,
  nonZeroMask,
  PRODUCT_RESIZE_KERNEL,
  rawToSharp,
  solidCanvas,
  type ProductPlacement,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { canvasDefaults, stillStyle } from "@curvi/pipeline/seed";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { ShotUnavailableError } from "./errors";
import type { LiveProduct, StillRender } from "./live-product";
import { canvasSizeFor, encodeForSpec, stillQcErosion } from "./shot-outputs";

type ShotType = Shot["type"];

export const DETERMINISTIC_LIVE_TYPES: ReadonlySet<ShotType> = new Set<ShotType>([
  "amazon_main",
  "alt_angle_white",
  "cutout_png",
  "sweep_gray",
  "sweep_brand",
  "collection_thumb",
]);

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export async function renderDeterministicShot(input: {
  shot: Shot;
  product: LiveProduct;
  brandColors?: string[];
}): Promise<StillRender> {
  const { shot, product } = input;
  if (shot.method !== "deterministic" || !DETERMINISTIC_LIVE_TYPES.has(shot.type)) {
    throw new ShotUnavailableError(
      `We cannot build a ${shot.type.replaceAll("_", " ")} shot from the product photo alone yet, so it needs review.`,
    );
  }
  const specId = shot.channels[0];
  if (!specId) {
    throw new ShotUnavailableError("This shot has no channel to size it for, so it needs review.");
  }
  const spec = getSpec(specId);
  if (!boundingBoxOfMask(product.mask)) {
    throw new ShotUnavailableError(
      "The cutout found no product in this photo, so this shot needs review.",
    );
  }

  switch (shot.type) {
    case "amazon_main":
    case "alt_angle_white":
    case "collection_thumb":
      return renderOnWhite(product, spec);
    case "cutout_png":
      return renderCutout(product, spec);
    case "sweep_gray":
      return renderSweep(product, spec, stillStyle.sweepGrayHex);
    case "sweep_brand":
      return renderSweep(product, spec, brandHex(input.brandColors));
    default:
      throw new ShotUnavailableError(
        `We cannot build a ${String(shot.type).replaceAll("_", " ")} shot from the product photo alone yet, so it needs review.`,
      );
  }
}

/** First valid brand kit hex, else the seeded fallback. */
function brandHex(brandColors: string[] | undefined): string {
  const found = (brandColors ?? []).map((c) => c.trim()).find((c) => HEX_COLOR.test(c));
  return found ?? stillStyle.fallbackBrandHex;
}

/** Product on pure white at the spec size, fill inside spec.fill. */
async function renderOnWhite(product: LiveProduct, spec: ChannelSpec): Promise<StillRender> {
  const main = await makeAmazonMain(product.productPng, product.maskPng, spec);
  const reference = await referenceFor(product, main.placement, main.width, main.height);
  return encodeStill(main.raw, main.mask, reference, spec, main.placement, main.jpeg);
}

/**
 * Transparent PNG cutout scaled and centered on a spec sized canvas. When the
 * spec does not take PNG or does not accept a transparent background, the
 * cutout is flattened onto white at the spec size instead (the same
 * treatment as the main image), because a transparent file would fail the
 * channel's upload rules.
 */
async function renderCutout(product: LiveProduct, spec: ChannelSpec): Promise<StillRender> {
  if (!allowsTransparency(spec)) {
    return renderOnWhite(product, spec);
  }
  const cutout = await makeCutoutPng(product.productPng, product.maskPng);
  const trimmed = await decodeToRgba(cutout.png);

  const { width: canvasW, height: canvasH } = canvasSizeFor(spec);
  const canvasLong = Math.max(canvasW, canvasH);
  const fillTarget = spec.fill
    ? Math.min(spec.fill.max, Math.max(spec.fill.min, canvasDefaults.cutoutFillTarget))
    : canvasDefaults.cutoutFillTarget;
  const scale = Math.min(
    (fillTarget * canvasLong) / Math.max(trimmed.width, trimmed.height),
    (canvasW * canvasDefaults.maxAxisShare) / trimmed.width,
    (canvasH * canvasDefaults.maxAxisShare) / trimmed.height,
  );
  const targetW = Math.max(1, Math.round(trimmed.width * scale));
  const targetH = Math.max(1, Math.round(trimmed.height * scale));
  const resized = await rawToSharp(trimmed)
    .resize(targetW, targetH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Fully transparent canvas; the cutout rows are copied in unchanged.
  const canvas = solidCanvas(canvasW, canvasH, 0, 0, 0, 0);
  const offsetX = Math.floor((canvasW - targetW) / 2);
  const offsetY = Math.floor((canvasH - targetH) / 2);
  for (let y = 0; y < targetH; y++) {
    const src = y * targetW * 4;
    resized.copy(canvas.data, ((y + offsetY) * canvasW + offsetX) * 4, src, src + targetW * 4);
  }

  const png = await encodePng(canvas);
  if (spec.maxBytes !== undefined && png.length > spec.maxBytes) {
    throw new ShotUnavailableError(
      "The transparent cutout came out larger than this channel allows, so it needs review.",
    );
  }
  const image = await decodeToRgba(png);
  // makeCutoutPng replaced the cutout alpha with the mask before trimming.
  const productReference = await referenceFor(
    product,
    { crop: cutout.crop, left: offsetX, top: offsetY, width: targetW, height: targetH, kernel: PRODUCT_RESIZE_KERNEL },
    canvasW,
    canvasH,
    "replace",
  );
  const mask = alphaMask(image);
  const fidelityErosion = await stillQcErosion(mask, targetW / cutout.crop.width);
  return { image, mask, encoded: { buffer: png, format: "png" }, productReference, fidelityErosion };
}

/** Studio sweep in the given color at the spec size. */
async function renderSweep(product: LiveProduct, spec: ChannelSpec, hex: string): Promise<StillRender> {
  if (spec.background?.type === "solid") {
    // A colored sweep can never meet a solid background rule honestly.
    throw new ShotUnavailableError(
      "This channel needs a plain solid background, so a studio sweep cannot be used here and it needs review.",
    );
  }
  const sweep = await makeSweep(product.productPng, product.maskPng, hex, {
    width: spec.width,
    height: spec.height,
  });
  const reference = await referenceFor(product, sweep.placement, sweep.width, sweep.height);
  return encodeStill(sweep.raw, sweep.mask, reference, spec, sweep.placement, sweep.jpeg);
}

/**
 * Rule 3 reference rebuilt from the encoded cutout the helper decoded and
 * the placement it reports, independently of any background compositing.
 */
async function referenceFor(
  product: LiveProduct,
  placement: ProductPlacement,
  width: number,
  height: number,
  alphaFromMask?: "replace",
): Promise<RawImage> {
  const source = await decodeToRgba(product.productPng);
  const alpha = alphaFromMask ? { mask: await decodeMask(product.maskPng), mode: alphaFromMask } : undefined;
  return buildProductReference(source, placement, width, height, { alpha });
}

function allowsTransparency(spec: ChannelSpec): boolean {
  if (spec.formats && !spec.formats.includes("png")) {
    return false;
  }
  const bg = spec.background?.type;
  return bg === undefined || bg === "any" || bg === "consistent" || bg === "white_or_transparent";
}

/**
 * Encodes a placed still for its spec (see encodeForSpec) after sizing the
 * rule 3 check region from the placement scale, so the encoding is verified
 * with exactly the erosion the runner applies. A thin product gets a smaller
 * erosion (never into the resize edge band) instead of an empty region.
 */
async function encodeStill(
  raw: RawImage,
  mask: RawMask,
  productReference: RawImage,
  spec: ChannelSpec,
  placement: ProductPlacement,
  firstJpeg: Buffer,
): Promise<StillRender> {
  const fidelityErosion = await stillQcErosion(mask, placement.width / Math.max(1, placement.crop.width));
  const out = await encodeForSpec(raw, mask, productReference, spec, {
    firstJpeg,
    erodePx: fidelityErosion.erodePx,
  });
  return { image: out.image, mask, encoded: out.encoded, productReference, fidelityErosion };
}

function alphaMask(image: RawImage): RawMask {
  const data = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = image.data[i * 4 + 3];
  }
  return nonZeroMask({ data, width: image.width, height: image.height });
}
