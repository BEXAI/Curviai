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
  dilate,
  encodeJpeg,
  encodePng,
  fidelityReport,
  makeAmazonMain,
  makeCutoutPng,
  makeSweep,
  nonZeroMask,
  PRODUCT_RESIZE_KERNEL,
  qcKindForSpec,
  rawToSharp,
  solidCanvas,
  type ProductPlacement,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { stillStyle } from "@curvi/pipeline/seed";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import type { LiveProduct, StillRender } from "./live-product";
import { ShotUnavailableError } from "./pipeline-runner";

type ShotType = Shot["type"];

export const DETERMINISTIC_LIVE_TYPES: ReadonlySet<ShotType> = new Set<ShotType>([
  "amazon_main",
  "alt_angle_white",
  "cutout_png",
  "sweep_gray",
  "sweep_brand",
  "collection_thumb",
]);

/** Matches the QC edge margin the runner passes to pixelChecks. */
const QC_EDGE_MARGIN_PX = 2;
/** JPEG quality ladder, same steps as the whiten helper's encoder. */
const JPEG_QUALITIES = [90, 80, 70, 60, 50, 40] as const;
/** Higher qualities tried, in order, when a JPEG fails the rule 3 check. */
const JPEG_FIDELITY_QUALITIES = [95, 98, 100] as const;
/** Product longest side over canvas longest side for the transparent cutout
 * when the spec sets no fill rule; mirrors makeAmazonMain's default target. */
const CUTOUT_FILL_TARGET = 0.875;

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
  return encodeForSpec(main.raw, main.mask, reference, spec, { buffer: main.jpeg, format: "jpg" });
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

  const canvasW = spec.width ?? 2000;
  const canvasH = spec.height ?? canvasW;
  const canvasLong = Math.max(canvasW, canvasH);
  const fillTarget = spec.fill
    ? Math.min(spec.fill.max, Math.max(spec.fill.min, CUTOUT_FILL_TARGET))
    : CUTOUT_FILL_TARGET;
  const scale = Math.min(
    (fillTarget * canvasLong) / Math.max(trimmed.width, trimmed.height),
    (canvasW * 0.98) / trimmed.width,
    (canvasH * 0.98) / trimmed.height,
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
  return { image, mask: alphaMask(image), encoded: { buffer: png, format: "png" }, productReference };
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
  return encodeForSpec(sweep.raw, sweep.mask, reference, spec, { buffer: sweep.jpeg, format: "jpg" });
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
 * Pick an encoding the spec allows and that fits spec.maxBytes: JPEG first
 * (stepping quality down to fit), then lossless PNG. For a solid background
 * spec a JPEG is only kept when its decoded background is still exactly the
 * spec color outside the QC edge margin; codec ringing that dirties it sends
 * the shot to PNG, which keeps the forced background bit exact. A JPEG is
 * also only kept when its product pixels pass the same rule 3 fidelity check
 * the runner applies. On detailed products codec error can push single
 * pixels past the limit; then higher qualities are tried, and PNG after
 * those, instead of loosening the check.
 */
async function encodeForSpec(
  raw: RawImage,
  mask: RawMask,
  productReference: RawImage,
  spec: ChannelSpec,
  firstJpeg?: { buffer: Buffer; format: "jpg" },
): Promise<StillRender> {
  const maxBytes = spec.maxBytes ?? Number.POSITIVE_INFINITY;
  const allows = (f: string): boolean => !spec.formats || (spec.formats as readonly string[]).includes(f);
  const solidRgb = spec.background?.type === "solid" ? spec.background.rgb : undefined;
  const checkMask = solidRgb ? await dilate(mask, QC_EDGE_MARGIN_PX) : null;
  const kind = qcKindForSpec(spec);

  if (allows("jpg")) {
    for (const quality of JPEG_QUALITIES) {
      const buffer =
        quality === JPEG_QUALITIES[0] && firstJpeg ? firstJpeg.buffer : await encodeJpeg(raw, quality);
      if (buffer.length > maxBytes) {
        continue;
      }
      const image = await decodeToRgba(buffer);
      if (solidRgb && checkMask && !backgroundExact(image, checkMask, solidRgb)) {
        // Lower quality only adds more ringing; go straight to PNG.
        break;
      }
      if ((await fidelityReport(productReference, image, mask, { kind })).pass) {
        return { image, mask, encoded: { buffer, format: "jpg" }, productReference };
      }
      // Lower quality only drifts further from the product; try higher.
      for (const higher of JPEG_FIDELITY_QUALITIES) {
        if (higher <= quality) {
          continue;
        }
        const better = await encodeJpeg(raw, higher);
        if (better.length > maxBytes) {
          break;
        }
        const betterImage = await decodeToRgba(better);
        if (solidRgb && checkMask && !backgroundExact(betterImage, checkMask, solidRgb)) {
          continue;
        }
        if ((await fidelityReport(productReference, betterImage, mask, { kind })).pass) {
          return { image: betterImage, mask, encoded: { buffer: better, format: "jpg" }, productReference };
        }
      }
      break;
    }
  }
  if (allows("png")) {
    const buffer = await encodePng(raw);
    if (buffer.length <= maxBytes) {
      return { image: await decodeToRgba(buffer), mask, encoded: { buffer, format: "png" }, productReference };
    }
  }
  throw new ShotUnavailableError(
    "We could not save this image in a format and size this channel accepts, so it needs review.",
  );
}

function backgroundExact(image: RawImage, checkMask: RawMask, rgb: readonly [number, number, number]): boolean {
  for (let i = 0; i < checkMask.data.length; i++) {
    if (checkMask.data[i] !== 0) {
      continue;
    }
    const o = i * 4;
    if (image.data[o] !== rgb[0] || image.data[o + 1] !== rgb[1] || image.data[o + 2] !== rgb[2]) {
      return false;
    }
  }
  return true;
}

function alphaMask(image: RawImage): RawMask {
  const data = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = image.data[i * 4 + 3];
  }
  return nonZeroMask({ data, width: image.width, height: image.height });
}
