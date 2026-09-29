/**
 * Kept photos (docs/phases/PHASE_15.md, fidelity section): the seller's own
 * stored upload fitted to one channel spec. Nothing is generated, retouched
 * or cut out. The only operations, in order, in one sharp pipeline reading
 * the stored bytes:
 *
 * 1. Crop (P1 crop fit, and the already white file below).
 * 2. Resize with PRODUCT_RESIZE_KERNEL, one pass, fastShrinkOnLoad off, and
 *    only when the size changes. No sharpen, modulate or gamma.
 * 3. Conversion to 8 bit sRGB: an embedded ICC profile is transformed to
 *    sRGB (withIccProfile("srgb"), called only when the file embeds one),
 *    CMYK and YCCK go through libvips' own profile, 16 bit comes down to 8.
 * 4. Flatten, only for a photo with a real alpha channel: transparent areas
 *    take the pad color, and the alpha is the mask.
 * 5. Flat added space in one color. Never a blur, stretch, mirror or fill.
 *
 * Encoding is the runner's (encodeForSpec with fidelityKind "main"). When
 * every passthrough condition holds, the stored bytes ship unchanged instead
 * and nothing is decoded.
 *
 * The rule 3 proof: the mask is the placed photo rectangle (or the placed
 * alpha), and whiten.ts buildProductReferenceFromEncoded rebuilds the
 * reference from the same bytes and placement with no shared code.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { dimensionBounds, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import { dilate, type BBox } from "../mask";
import { canvasSizeFor, hexToRgb, originalFitFor, rgbToHex, SOURCE_TOO_SMALL_REASON } from "../output-options";
import { minLongSideFor, QC_THRESHOLDS } from "../qc/pixelChecks";
import type { RawImage, RawMask } from "../raw";
import { canvasDefaults, originalFit, stillStyle } from "../seed/templates";
import type { PackAssetTreatment } from "../treatment";
import { PRODUCT_RESIZE_KERNEL, type ProductPlacement, type Rgb } from "./whiten";

/** A kept photo's fit: the seller's P0 choices, plus crop from P1. */
export type OriginalFitMode = "auto" | "pad" | "crop";

export interface OriginalFitOptions {
  fit: OriginalFitMode;
  /** Color of added space and of flattened transparent areas. */
  padRgb: Rgb;
  /** The most the photo is enlarged (MAX_SOURCE_UPSCALE, or 1 with Never enlarge in P1). */
  maxUpscale: number;
  /** Megapixel cap for every kept output (seed originalFit.maxMegapixels). */
  maxMegapixels: number;
  /** The product box in upright source pixels, needed by the P1 crop fit. */
  productBox?: BBox;
  /** The stored copy was written again at upload (source_media.ingest.reencoded). */
  reencodedAtUpload?: boolean;
}

/** The stored bytes, shipped as they are. */
export interface OriginalPassthrough {
  bytes: Buffer;
  /** Spec style format: jpg, png or webp. */
  format: string;
  /** sha256 of bytes, hex; the runner proves the delivered file matches it. */
  sha256: string;
}

interface OriginalFitCommon {
  /** Output canvas size. */
  width: number;
  height: number;
  /** Where the photo sits on the canvas; crop is the whole frame in P0. */
  placement: ProductPlacement;
  treatment: PackAssetTreatment;
}

/** A kept photo rendered as pixels for the runner to encode. */
export interface OriginalRender extends OriginalFitCommon {
  raw: RawImage;
  /** The rule 3 mask: 255 over the placed rectangle, or the placed alpha. */
  mask: RawMask;
  passthrough?: undefined;
  /** The source is PNG or lossless WebP, so the encode ladder tries PNG first. */
  preferPng: boolean;
}

/** A kept photo that ships as the stored bytes; nothing was decoded. */
export interface OriginalUnchanged extends OriginalFitCommon {
  raw?: undefined;
  mask?: undefined;
  passthrough: OriginalPassthrough;
}

export type OriginalFitResult = OriginalRender | OriginalUnchanged;

/** The photo cannot reach the spec within the enlarge cap. The planner skips
 * these at plan time; this is the renderer's last guard. */
export class SourceTooSmallError extends Error {
  readonly reason = SOURCE_TOO_SMALL_REASON;
  constructor(specId: string) {
    super(`${SOURCE_TOO_SMALL_REASON}: ${specId}`);
    this.name = "SourceTooSmallError";
  }
}

/** Seam for the P1 crop fit (PHASE_15 P1 "Trim to the channel's shape"). */
export class CropFitUnavailableError extends Error {
  constructor() {
    super("The crop fit is not available yet");
    this.name = "CropFitUnavailableError";
  }
}

/** What the renderer needs to know about the stored upload, read from its header. */
export interface SourceFacts {
  /** Upright size. */
  width: number;
  height: number;
  /** Spec style format (jpg, png, webp, tif, gif, heif) or "unknown". */
  format: string;
  space: string;
  depth: string;
  /** The file has an alpha channel. */
  hasAlpha: boolean;
  /** The alpha channel has a pixel below fully opaque; read only when hasAlpha. */
  realAlpha: boolean;
  /** EXIF orientation other than 1. */
  rotated: boolean;
  /** Embedded ICC profile description, or null when there is no profile. */
  iccDescription: string | null;
  hasIcc: boolean;
  /** Carries EXIF, XMP or IPTC metadata. */
  hasMetadata: boolean;
  /** PNG, or WebP stored losslessly. */
  lossless: boolean;
}

/** Reads the facts makeOriginalFit decides with. Only the alpha test decodes pixels. */
export async function sourceFacts(bytes: Buffer): Promise<SourceFacts> {
  const meta = await sharp(bytes).metadata();
  const rotated = (meta.orientation ?? 1) !== 1;
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  const hasAlpha = meta.hasAlpha === true;
  const realAlpha = hasAlpha ? !(await sharp(bytes).stats()).isOpaque : false;
  const format = specFormat(meta.format);
  return {
    width,
    height,
    format,
    space: meta.space ?? "unknown",
    depth: meta.depth ?? "unknown",
    hasAlpha,
    realAlpha,
    rotated,
    iccDescription: meta.icc ? iccProfileDescription(meta.icc) : null,
    hasIcc: Boolean(meta.icc),
    hasMetadata: Boolean(meta.exif || meta.xmp || meta.iptc),
    lossless: format === "png" || (format === "webp" && webpIsLossless(bytes)),
  };
}

/** True when the file's color needs a conversion to reach 8 bit sRGB. */
export function needsColorConversion(facts: SourceFacts): boolean {
  if (facts.space === "cmyk" || facts.depth !== "uchar") {
    return true;
  }
  return facts.hasIcc && !isSrgbProfileName(facts.iccDescription);
}

/** The ICC description is one of seed originalFit.srgbProfileNames. */
export function isSrgbProfileName(description: string | null): boolean {
  return description !== null && (originalFit.srgbProfileNames as readonly string[]).includes(description.trim());
}

/**
 * Fits a kept photo to one spec (PHASE_15 control 6 and the fidelity
 * section). auto keeps the photo's shape; pad (and every exact size spec)
 * places it on canvasSizeFor(spec) with flat added space, inside the safe
 * zone when the spec has one; a spec that refuses added borders always keeps
 * the photo's shape (originalFitFor). Throws SourceTooSmallError when auto
 * cannot reach the spec within maxUpscale, and CropFitUnavailableError for
 * the P1 crop fit.
 */
export async function makeOriginalFit(
  sourceBytes: Buffer,
  spec: ChannelSpec,
  opts: OriginalFitOptions,
): Promise<OriginalFitResult> {
  if (opts.fit === "crop") {
    throw new CropFitUnavailableError();
  }
  const facts = await sourceFacts(sourceBytes);
  if (!(facts.width > 0 && facts.height > 0)) {
    throw new Error("The stored photo has no readable size");
  }
  const fit = originalFitFor(spec, { fit: opts.fit });
  const scaled = keptScale(facts, spec, fit, opts);
  if (scaled.skip) {
    throw new SourceTooSmallError(spec.id);
  }
  const { width: placedW, height: placedH, scale } = scaled;

  let canvasW = placedW;
  let canvasH = placedH;
  let left = 0;
  let top = 0;
  if (fit === "pad") {
    const canvas = canvasSizeFor(spec);
    canvasW = canvas.width;
    canvasH = canvas.height;
    const zoneTop = spec.safeZone?.top ?? 0;
    const zoneH = Math.max(1, canvasH - zoneTop - (spec.safeZone?.bottom ?? 0));
    left = Math.floor((canvasW - placedW) / 2);
    top = zoneTop + Math.max(0, Math.floor((zoneH - placedH) / 2));
  }
  const placement: ProductPlacement = {
    crop: { left: 0, top: 0, width: facts.width, height: facts.height },
    left,
    top,
    width: placedW,
    height: placedH,
    kernel: PRODUCT_RESIZE_KERNEL,
  };
  const added = canvasW !== placedW || canvasH !== placedH;
  const colorConverted = needsColorConversion(facts);
  const treatment: PackAssetTreatment = {
    kind: "original",
    scale,
    sourceWidth: facts.width,
    sourceHeight: facts.height,
    ...(opts.reencodedAtUpload ? { reencodedAtUpload: true } : {}),
    ...(colorConverted ? { colorConverted: true } : {}),
    ...(facts.realAlpha ? { alphaFilledHex: rgbToHex(opts.padRgb) } : {}),
    ...(added ? { padHex: rgbToHex(opts.padRgb) } : {}),
  };

  if (!added && scale === 1 && passesThrough(facts, sourceBytes.length, spec, opts.maxMegapixels)) {
    return {
      width: placedW,
      height: placedH,
      placement,
      treatment: { ...treatment, kind: "original_unchanged" },
      passthrough: {
        bytes: sourceBytes,
        format: facts.format,
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    };
  }

  const { raw, mask } = await renderPlaced(sourceBytes, facts, placement, { width: canvasW, height: canvasH }, opts.padRgb);
  return { width: canvasW, height: canvasH, placement, treatment, raw, mask, preferPng: facts.lossless };
}

/**
 * The unchanged file rule: every condition must hold (the caller has
 * already checked s is 1 with no crop, added space or flatten).
 */
function passesThrough(facts: SourceFacts, bytes: number, spec: ChannelSpec, maxMegapixels: number): boolean {
  if (spec.formats && !(spec.formats as readonly string[]).includes(facts.format)) {
    return false;
  }
  if (spec.maxBytes !== undefined && bytes > spec.maxBytes) {
    return false;
  }
  const megapixels = (facts.width * facts.height) / 1_000_000;
  if (megapixels > maxMegapixels || megapixels > (spec.maxMegapixels ?? Number.POSITIVE_INFINITY)) {
    return false;
  }
  if (facts.space !== "srgb" || facts.depth !== "uchar" || facts.realAlpha || facts.rotated || facts.hasMetadata) {
    return false;
  }
  return !facts.hasIcc || isSrgbProfileName(facts.iccDescription);
}

export interface KeptScale {
  scale: number;
  width: number;
  height: number;
  skip?: typeof SOURCE_TOO_SMALL_REASON;
}

/**
 * The PHASE_15 control 6 scale with the caps as arguments:
 * s = min(maxW / w, maxH / h, maxLongSide / long, sqrt(maxMP / (w * h)), 1),
 * maxMP the smaller of spec.maxMegapixels and maxMegapixels. auto raises s to
 * meet minLongSideFor(spec), minWidth and minHeight, never above maxUpscale
 * nor past a maximum, or skips. pad fits the canvas (inside the safe zone)
 * and never enlarges. With the seeded caps it equals output-options
 * originalScale; a test holds the two together.
 */
export function keptScale(
  photo: { width: number; height: number },
  spec: ChannelSpec,
  fit: "auto" | "pad",
  caps: { maxUpscale: number; maxMegapixels: number },
): KeptScale {
  const { width: w, height: h } = photo;
  const maxMegapixels = Math.min(spec.maxMegapixels ?? Number.POSITIVE_INFINITY, caps.maxMegapixels);
  // Rounding may land a pixel over the megapixel cap; round down then.
  const placed = (scale: number): KeptScale => {
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    if (width * height <= maxMegapixels * 1_000_000) {
      return { scale, width, height };
    }
    return { scale, width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
  };
  const byMegapixels = Math.sqrt((maxMegapixels * 1_000_000) / (w * h));
  if (fit === "pad") {
    const canvas = canvasSizeFor(spec);
    const safeHeight = canvas.height - (spec.safeZone?.top ?? 0) - (spec.safeZone?.bottom ?? 0);
    return placed(Math.min(canvas.width / w, Math.max(1, safeHeight) / h, byMegapixels, 1));
  }
  const bounds = dimensionBounds(spec);
  const long = Math.max(w, h);
  const upper = Math.min(bounds.maxWidth / w, bounds.maxHeight / h, bounds.maxLongSide / long, byMegapixels);
  const need = Math.max(minLongSideFor(spec) / long, bounds.minWidth / w, bounds.minHeight / h);
  const scale = Math.min(upper, 1);
  if (scale >= need) {
    return placed(scale);
  }
  if (need > caps.maxUpscale || need > upper) {
    return { ...placed(Math.min(need, upper, caps.maxUpscale)), skip: SOURCE_TOO_SMALL_REASON };
  }
  return placed(need);
}

/**
 * The one sharp pipeline every rendered kept output goes through, then the
 * flat canvas. Only the placed rectangle is decoded into JS memory.
 */
async function renderPlaced(
  sourceBytes: Buffer,
  facts: SourceFacts,
  placement: ProductPlacement,
  canvas: { width: number; height: number },
  padRgb: Rgb,
): Promise<{ raw: RawImage; mask: RawMask }> {
  const { crop, width, height, left, top } = placement;
  let pipeline = sharp(sourceBytes).rotate();
  if (facts.hasIcc) {
    pipeline = pipeline.withIccProfile("srgb");
  }
  if (crop.left !== 0 || crop.top !== 0 || crop.width !== facts.width || crop.height !== facts.height) {
    pipeline = pipeline.extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height });
  }
  if (width !== crop.width || height !== crop.height) {
    pipeline = pipeline.resize(width, height, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL, fastShrinkOnLoad: false });
  }
  const { data: placed, info } = await pipeline
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.width !== width || info.height !== height) {
    throw new Error(`Kept photo decode gave ${info.width}x${info.height}x${info.channels}, expected ${width}x${height}x4`);
  }

  const [padR, padG, padB] = padRgb;
  const flatten = facts.realAlpha;
  const sameCanvas = canvas.width === width && canvas.height === height && left === 0 && top === 0;
  const out = sameCanvas ? placed : Buffer.alloc(canvas.width * canvas.height * 4);
  const maskData = Buffer.alloc(canvas.width * canvas.height, 0);
  if (!sameCanvas) {
    for (let i = 0; i < canvas.width * canvas.height; i++) {
      const o = i * 4;
      out[o] = padR;
      out[o + 1] = padG;
      out[o + 2] = padB;
      out[o + 3] = 255;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const at = (y + top) * canvas.width + (x + left);
      const dst = at * 4;
      const a = flatten ? placed[src + 3] : 255;
      if (a === 255) {
        out[dst] = placed[src];
        out[dst + 1] = placed[src + 1];
        out[dst + 2] = placed[src + 2];
      } else {
        out[dst] = Math.round((a * placed[src] + (255 - a) * padR) / 255);
        out[dst + 1] = Math.round((a * placed[src + 1] + (255 - a) * padG) / 255);
        out[dst + 2] = Math.round((a * placed[src + 2] + (255 - a) * padB) / 255);
      }
      out[dst + 3] = 255;
      maskData[at] = a;
    }
  }
  return {
    raw: { data: out, width: canvas.width, height: canvas.height, channels: 4 },
    mask: { data: maskData, width: canvas.width, height: canvas.height },
  };
}

// ---------------------------------------------------------------------------
// Already white photos (PHASE_15 control 7)
// ---------------------------------------------------------------------------

/** Share of pixels outside the dilated product mask that must be exactly
 * white (or fully transparent): the main class check after forcing. */
function alreadyWhiteShareRequired(): number {
  return QC_THRESHOLDS.main.backgroundWhiteShareAfterForcing;
}

/** The white a white required spec takes: its registry rgb, else seed white. */
function specWhite(spec: ChannelSpec): Rgb {
  if (spec.background?.rgb) {
    const [r, g, b] = spec.background.rgb;
    return [r, g, b];
  }
  return hexToRgb(stillStyle.whiteHex);
}

export interface AlreadyWhiteDetection {
  alreadyWhite: boolean;
  /** Share of pixels outside the dilated mask that are exactly white or clear. */
  whiteShare: number | null;
  /** Why the photo does not count as already white. */
  reason?: "not_white_required" | "mask_empty" | "mask_mismatch" | "background_not_white";
}

/**
 * Whether a kept photo already sits on pure white for a white required spec:
 * every pixel outside the preflight mask, dilated by edgeMarginPx, is exactly
 * the spec white (or fully transparent, which the white file fills with
 * white). The mask may be smaller than the photo (the preflight cutout runs
 * on the working size); the photo is then read at the mask's size.
 */
export async function detectAlreadyWhite(
  sourceBytes: Buffer,
  mask: RawMask,
  spec: ChannelSpec,
  opts: { edgeMarginPx: number },
): Promise<AlreadyWhiteDetection> {
  if (!requiresWhiteBackground(spec)) {
    return { alreadyWhite: false, whiteShare: null, reason: "not_white_required" };
  }
  const facts = await sourceFacts(sourceBytes);
  if (!sameAspect(facts, mask)) {
    return { alreadyWhite: false, whiteShare: null, reason: "mask_mismatch" };
  }
  let pipeline = sharp(sourceBytes).rotate();
  if (facts.hasIcc) {
    pipeline = pipeline.withIccProfile("srgb");
  }
  if (mask.width !== facts.width || mask.height !== facts.height) {
    // A kernel with no negative lobes: pure white stays exactly white and a
    // product edge spreads no further than the kernel, where lanczos3 would
    // ring past the edge margin. Detection only; the file is rendered and
    // checked again at full size.
    pipeline = pipeline.resize(mask.width, mask.height, {
      fit: "fill",
      kernel: "linear",
      fastShrinkOnLoad: false,
    });
  }
  const { data } = await pipeline
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  const checkMask = opts.edgeMarginPx > 0 ? await dilate(mask, opts.edgeMarginPx) : mask;
  const share = whiteOrClearShareOutside(data, checkMask, specWhite(spec));
  if (share === null) {
    return { alreadyWhite: false, whiteShare: null, reason: "mask_empty" };
  }
  const alreadyWhite = share >= alreadyWhiteShareRequired();
  return { alreadyWhite, whiteShare: share, ...(alreadyWhite ? {} : { reason: "background_not_white" }) };
}

export interface AlreadyWhiteOptions {
  /** The most the photo is enlarged to reach the fill target. */
  maxUpscale: number;
  /** The QC edge margin; the finished file is checked with it. */
  edgeMarginPx: number;
  reencodedAtUpload?: boolean;
}

/** The white required file made from the photo itself. */
export interface AlreadyWhiteFile {
  ok: true;
  raw: RawImage;
  /** The rule 3 mask: 255 over the placed photo rectangle. */
  mask: RawMask;
  /** The preflight product mask placed on the canvas, for the pixel checks
   * (background share and fill), which measure the product, not the photo. */
  productMask: RawMask;
  width: number;
  height: number;
  placement: ProductPlacement;
  /** Product longest side over the canvas longest side. */
  fillRatio: number;
  treatment: PackAssetTreatment;
}

/** Why crop, resize and white pad alone cannot make the file; the caller
 * falls back to the made white path. */
export interface AlreadyWhiteUnreachable {
  ok: false;
  reason: "not_white_required" | "mask_empty" | "mask_mismatch" | "fill_unreachable" | "background_not_white";
}

/**
 * The white required file for an already white photo (control 7): the photo
 * cropped around the product, resized so the product meets the spec's fill
 * target, and padded with white where the crop window runs past the photo,
 * all through the same pipeline as every kept output. No composite and no
 * cutout pixels. Returns ok false when that cannot reach spec.fill within
 * maxUpscale, or when the finished canvas fails the white background check.
 */
export async function makeAlreadyWhite(
  sourceBytes: Buffer,
  mask: RawMask,
  spec: ChannelSpec,
  opts: AlreadyWhiteOptions,
): Promise<AlreadyWhiteFile | AlreadyWhiteUnreachable> {
  if (!requiresWhiteBackground(spec)) {
    return { ok: false, reason: "not_white_required" };
  }
  const facts = await sourceFacts(sourceBytes);
  if (!sameAspect(facts, mask)) {
    return { ok: false, reason: "mask_mismatch" };
  }
  const box = maskBox(mask);
  if (!box) {
    return { ok: false, reason: "mask_empty" };
  }
  const sx = facts.width / mask.width;
  const sy = facts.height / mask.height;
  const product = {
    left: box.left * sx,
    top: box.top * sy,
    width: box.width * sx,
    height: box.height * sy,
  };

  const canvas = canvasSizeFor(spec);
  const canvasLong = Math.max(canvas.width, canvas.height);
  const fillRange = whiteFillRange(spec);
  const target = clamp(canvasDefaults.cutoutFillTarget, fillRange.min, fillRange.max);
  const scale = Math.min(
    (target * canvasLong) / Math.max(product.width, product.height),
    (canvas.width * canvasDefaults.maxAxisShare) / product.width,
    (canvas.height * canvasDefaults.maxAxisShare) / product.height,
  );
  const reached = (Math.max(product.width, product.height) * scale) / canvasLong;
  if (scale > opts.maxUpscale || reached < fillRange.min || reached > fillRange.max) {
    return { ok: false, reason: "fill_unreachable" };
  }

  // The canvas window in source pixels, centered on the product, and the part
  // of it the photo covers. The rest is white pad.
  const windowW = canvas.width / scale;
  const windowH = canvas.height / scale;
  const windowLeft = product.left + product.width / 2 - windowW / 2;
  const windowTop = product.top + product.height / 2 - windowH / 2;
  const cropLeft = Math.max(0, Math.floor(windowLeft));
  const cropTop = Math.max(0, Math.floor(windowTop));
  const cropRight = Math.min(facts.width, Math.ceil(windowLeft + windowW));
  const cropBottom = Math.min(facts.height, Math.ceil(windowTop + windowH));
  const crop = { left: cropLeft, top: cropTop, width: cropRight - cropLeft, height: cropBottom - cropTop };
  const placedW = Math.min(canvas.width, Math.max(1, Math.round(crop.width * scale)));
  const placedH = Math.min(canvas.height, Math.max(1, Math.round(crop.height * scale)));
  const left = clamp(Math.round((crop.left - windowLeft) * scale), 0, canvas.width - placedW);
  const top = clamp(Math.round((crop.top - windowTop) * scale), 0, canvas.height - placedH);
  const placement: ProductPlacement = { crop, left, top, width: placedW, height: placedH, kernel: PRODUCT_RESIZE_KERNEL };

  const white = specWhite(spec);
  const { raw, mask: alphaMask } = await renderPlaced(sourceBytes, facts, placement, canvas, white);
  // The rule 3 mask is the placed rectangle, whatever the photo's alpha.
  const rectMask = alphaMask;
  for (let y = 0; y < placedH; y++) {
    rectMask.data.fill(255, (y + top) * canvas.width + left, (y + top) * canvas.width + left + placedW);
  }

  const productMask = await placeMask(mask, facts, scale, placement, canvas);
  const checkMask = opts.edgeMarginPx > 0 ? await dilate(productMask, opts.edgeMarginPx) : productMask;
  const share = whiteOrClearShareOutside(raw.data, checkMask, white);
  if (share === null || share < alreadyWhiteShareRequired()) {
    return { ok: false, reason: "background_not_white" };
  }
  const placedBox = maskBox(productMask);
  const fillRatio = placedBox ? Math.max(placedBox.width, placedBox.height) / canvasLong : 0;
  if (fillRatio < fillRange.min || fillRatio > fillRange.max) {
    return { ok: false, reason: "fill_unreachable" };
  }

  const added = placedW !== canvas.width || placedH !== canvas.height;
  const treatment: PackAssetTreatment = {
    kind: "original",
    alreadyWhite: true,
    cropped: crop.width !== facts.width || crop.height !== facts.height,
    scale,
    sourceWidth: facts.width,
    sourceHeight: facts.height,
    ...(opts.reencodedAtUpload ? { reencodedAtUpload: true } : {}),
    ...(needsColorConversion(facts) ? { colorConverted: true } : {}),
    ...(facts.realAlpha ? { alphaFilledHex: rgbToHex(white) } : {}),
    ...(added ? { padHex: rgbToHex(white) } : {}),
  };
  return {
    ok: true,
    raw,
    mask: rectMask,
    productMask,
    width: canvas.width,
    height: canvas.height,
    placement,
    fillRatio,
    treatment,
  };
}

/** The fill range the white file must land in: the spec's, else the main class row. */
function whiteFillRange(spec: ChannelSpec): { min: number; max: number } {
  return spec.fill ?? { min: QC_THRESHOLDS.main.fillMin, max: QC_THRESHOLDS.main.fillMax };
}

/**
 * The preflight mask moved onto the canvas the way the photo was: scaled by
 * the photo scale times the mask to photo ratio, then the crop window cut out
 * and placed. Used for the pixel checks only, never for the rule 3 proof.
 */
async function placeMask(
  mask: RawMask,
  facts: SourceFacts,
  scale: number,
  placement: ProductPlacement,
  canvas: { width: number; height: number },
): Promise<RawMask> {
  const fullW = Math.max(1, Math.round(facts.width * scale));
  const fullH = Math.max(1, Math.round(facts.height * scale));
  const regionLeft = Math.min(Math.max(0, Math.round(placement.crop.left * scale)), fullW - 1);
  const regionTop = Math.min(Math.max(0, Math.round(placement.crop.top * scale)), fullH - 1);
  const regionW = Math.min(placement.width, fullW - regionLeft);
  const regionH = Math.min(placement.height, fullH - regionTop);
  const region = await sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .resize(fullW, fullH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .extract({ left: regionLeft, top: regionTop, width: regionW, height: regionH })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  const out = Buffer.alloc(canvas.width * canvas.height, 0);
  for (let y = 0; y < regionH; y++) {
    for (let x = 0; x < regionW; x++) {
      if (region[y * regionW + x] >= 128) {
        out[(y + placement.top) * canvas.width + (x + placement.left)] = 255;
      }
    }
  }
  return { data: out, width: canvas.width, height: canvas.height };
}

/** Share of RGBA pixels outside the mask that are exactly rgb or fully clear; null when none are outside. */
function whiteOrClearShareOutside(data: Buffer, mask: RawMask, rgb: Rgb): number | null {
  let outside = 0;
  let white = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] !== 0) {
      continue;
    }
    outside++;
    const o = i * 4;
    if (data[o + 3] === 0 || (data[o] === rgb[0] && data[o + 1] === rgb[1] && data[o + 2] === rgb[2])) {
      white++;
    }
  }
  if (outside === 0) {
    return null;
  }
  return white / outside;
}

function maskBox(mask: RawMask): BBox | null {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x] >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Same aspect ratio within one percent. */
function sameAspect(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) {
    return false;
  }
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / rb <= 0.01;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function specFormat(format: string | undefined): string {
  switch (format) {
    case undefined:
      return "unknown";
    case "jpeg":
      return "jpg";
    case "tiff":
      return "tif";
    default:
      return format;
  }
}

/** A WebP whose image chunk is VP8L (lossless). Reads the RIFF chunk list only. */
function webpIsLossless(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    return false;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.toString("latin1", offset, offset + 4);
    if (fourcc === "VP8L") {
      return true;
    }
    if (fourcc === "VP8 ") {
      return false;
    }
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return false;
}

/**
 * The description of an ICC profile: the v2 textDescriptionType ("desc") or
 * the v4 multiLocalizedUnicodeType ("mluc", English record first, else the
 * first record). Null when the profile is malformed or has no description.
 */
export function iccProfileDescription(icc: Buffer): string | null {
  try {
    if (icc.length < 132) {
      return null;
    }
    const tagCount = icc.readUInt32BE(128);
    for (let i = 0; i < tagCount; i++) {
      const entry = 132 + i * 12;
      if (entry + 12 > icc.length) {
        return null;
      }
      if (icc.toString("latin1", entry, entry + 4) !== "desc") {
        continue;
      }
      const offset = icc.readUInt32BE(entry + 4);
      const size = icc.readUInt32BE(entry + 8);
      if (offset + size > icc.length || size < 12) {
        return null;
      }
      const type = icc.toString("latin1", offset, offset + 4);
      if (type === "desc") {
        const count = icc.readUInt32BE(offset + 8);
        const end = Math.min(offset + 12 + count, offset + size);
        return icc.toString("latin1", offset + 12, end).replace(/\0+$/, "");
      }
      if (type === "mluc") {
        const records = icc.readUInt32BE(offset + 8);
        const recordSize = icc.readUInt32BE(offset + 12);
        let chosen: { length: number; at: number } | null = null;
        for (let r = 0; r < records; r++) {
          const rec = offset + 16 + r * recordSize;
          if (rec + 12 > offset + size) {
            break;
          }
          const lang = icc.toString("latin1", rec, rec + 2);
          const found = { length: icc.readUInt32BE(rec + 4), at: offset + icc.readUInt32BE(rec + 8) };
          if (!chosen || lang === "en") {
            chosen = found;
          }
          if (lang === "en") {
            break;
          }
        }
        if (!chosen || chosen.at + chosen.length > icc.length) {
          return null;
        }
        let text = "";
        for (let k = 0; k + 1 < chosen.length; k += 2) {
          text += String.fromCharCode(icc.readUInt16BE(chosen.at + k));
        }
        return text.replace(/\0+$/, "");
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}
