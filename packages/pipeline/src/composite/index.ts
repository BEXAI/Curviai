/**
 * Generative compositing (CURVI_BUILD_PLAN.md section 5.5). The provider
 * paints the scene plate and harmonizes light and shadow, but the final step
 * pastes the original product pixels back inside the eroded mask with a 3 px
 * feather. Only a single global color transform may touch product pixels
 * (identity for now, hook exposed). CLAUDE.md rule 3.
 *
 * Edge handling: the feather only works inward (never past the product
 * mask, so no dark halo from the transparent cutout surroundings), and
 * outside the pure paste core it is weighted by the cutout's own soft alpha,
 * so hair, fur and glass edges blend with the scene instead of stair
 * stepping. The core stays byte identical either way.
 */
import sharp from "sharp";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "@curvi/ai";
import { boundingBoxOfMask, erode, feather, nonZeroMask } from "../mask";
import { decodeToRgba, encodePng, type RawImage, type RawMask } from "../raw";
import type { QCVerdict, Shot } from "../schemas";

/** Compiled template inputs for one composite shot. Prompts come from the
 * recipes and templates seed, never from this module. */
export interface CompositeTemplate {
  width: number;
  height: number;
  scenePrompt: string;
  harmonizePrompt: string;
  placement?: {
    /** Product center as a fraction of canvas width. Default 0.5. */
    centerX?: number;
    /** Product center as a fraction of canvas height. Default 0.58. */
    centerY?: number;
    /** Product longest side over the canvas shortest side. Default 0.55. */
    fill?: number;
  };
}

/**
 * Paste back constants. The QC fidelity check derives its default erosion
 * from these (see src/qc/fidelity deriveQcErodePx): the QC region must sit
 * strictly inside the pure paste region, so QC erode >= paste erode +
 * ceil(paste feather) + 1.
 */
/** Default erosion applied to the paste back mask edge. */
export const PASTE_ERODE_PX = 3;
/** Default feather width at the paste back edge. */
export const PASTE_FEATHER_PX = 3;
/**
 * Adaptive erosion floor: the eroded paste mask must keep at least this share
 * of the original mask area, otherwise the radius is reduced (down to 0,
 * meaning paste the full mask). Protects thin products (chains, cables,
 * rings) whose mask a fixed erosion would annihilate, leaving the product
 * entirely regenerated.
 */
export const MIN_PASTE_AREA_SHARE = 0.4;

/** Payload contract for image providers used by this pipeline. */
export interface ScenePlateInput {
  prompt: string;
  width: number;
  height: number;
}
export interface HarmonizeInput {
  prompt: string;
  png: Buffer;
  /**
   * Canvas size the output must keep the shape of. The draft png is this
   * size; an output of another aspect ratio lands out of register with the
   * pasted product and is rejected (see assertHarmonizeAspect).
   */
  width: number;
  height: number;
}
export interface ImageOutput {
  png: Buffer;
}

/**
 * A single global color transform applied to the product pixels before paste
 * back (white balance or exposure match). Never a local repaint.
 */
export type GlobalColorTransform = (product: RawImage) => RawImage;

export const identityColorTransform: GlobalColorTransform = (product) => product;

export interface CompositeShotArgs {
  /** Product cutout at source resolution, RGBA. */
  productRgba: RawImage;
  /** Product mask at source resolution. */
  mask: RawMask;
  provider: Provider;
  shot: Shot;
  template: CompositeTemplate;
  /** Global color transform hook. Defaults to identity. */
  colorTransform?: GlobalColorTransform;
  /**
   * Erosion applied to the paste back mask edge. Default PASTE_ERODE_PX.
   * Clamped adaptively: the radius is reduced until the eroded mask keeps at
   * least MIN_PASTE_AREA_SHARE of the mask area. The applied radius is
   * reported as effectivePasteErodePx on the result.
   */
  pasteErodePx?: number;
  /** Feather width at the paste back edge. Default PASTE_FEATHER_PX. */
  pasteFeatherPx?: number;
  workspaceId?: string;
  jobId?: string;
}

export interface CompositeResult {
  /** Final encoded PNG. */
  png: Buffer;
  /** Final raw RGBA canvas. */
  finalRaw: RawImage;
  /** Binary product mask at canvas scale and position. */
  canvasMask: RawMask;
  /**
   * Weight the product reference was pasted with over the harmonized
   * scene: 255 on the eroded core, the feather times the cutout alpha on the
   * edge band, and 0 everywhere outside canvasMask.
   */
  pasteAlpha: RawMask;
  /** The cutout's own alpha, scaled and placed on the canvas (0 off the product). */
  cutoutAlpha: RawMask;
  /**
   * Canvas sized image holding the exact product pixels that must survive:
   * the scaled product placed at its offset (after the global color
   * transform). fidelityReport(productReference, finalRaw, canvasMask) proves
   * the paste back.
   */
  productReference: RawImage;
  /**
   * Paste erosion radius actually applied after the adaptive clamp. Equals
   * the requested pasteErodePx for chunky products; smaller (down to 0, full
   * mask paste) for thin products whose mask the requested radius would
   * annihilate. QC callers should erode by at least this value; the package
   * default (deriveQcErodePx) covers the unclamped case.
   */
  effectivePasteErodePx: number;
  costMicros: number;
}

export async function compositeShot(args: CompositeShotArgs): Promise<CompositeResult> {
  const {
    productRgba,
    mask,
    provider,
    shot,
    template,
    colorTransform = identityColorTransform,
    pasteErodePx = PASTE_ERODE_PX,
    pasteFeatherPx = PASTE_FEATHER_PX,
  } = args;
  if (productRgba.width !== mask.width || productRgba.height !== mask.height) {
    throw new Error("Product and mask dimensions must match");
  }
  const canvasW = template.width;
  const canvasH = template.height;
  let costMicros = 0;

  // Step a: scene plate from the provider.
  const plateRes = await provider.invoke<ScenePlateInput, ImageOutput>({
    task: "scene_plate",
    input: { prompt: template.scenePrompt, width: canvasW, height: canvasH },
    workspaceId: args.workspaceId,
    jobId: args.jobId,
    stepId: `${shot.id}:scene_plate`,
  });
  costMicros += plateRes.costMicros;
  const plate = await toCanvasRaw(plateRes.output.png, canvasW, canvasH);

  // Step b: place the original product pixels at the planned scale and position.
  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new Error("Mask is empty, cannot composite");
  }
  const placement = template.placement ?? {};
  const fill = placement.fill ?? 0.55;
  const centerX = placement.centerX ?? 0.5;
  const centerY = placement.centerY ?? 0.58;
  const bboxLong = Math.max(bbox.width, bbox.height);
  const scale = Math.min(
    (fill * Math.min(canvasW, canvasH)) / bboxLong,
    (canvasW * 0.95) / bbox.width,
    (canvasH * 0.95) / bbox.height,
  );
  const targetW = Math.max(1, Math.round(bbox.width * scale));
  const targetH = Math.max(1, Math.round(bbox.height * scale));

  const region = { left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height };
  const scaledProduct = await sharp(productRgba.data, {
    raw: { width: productRgba.width, height: productRgba.height, channels: 4 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const scaledMaskData = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: "lanczos3" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const offsetX = clampInt(Math.round(centerX * canvasW - targetW / 2), 0, canvasW - targetW);
  const offsetY = clampInt(Math.round(centerY * canvasH - targetH / 2), 0, canvasH - targetH);

  // The cutout's own alpha after the resize. Photoroom style cutouts carry
  // soft edges (hair, fur, glass) and fully transparent surroundings whose
  // RGB the premultiplied resize turns black; both are handled with this.
  const scaledAlpha = Buffer.alloc(targetW * targetH);
  for (let i = 0; i < scaledAlpha.length; i++) {
    scaledAlpha[i] = scaledProduct[i * 4 + 3];
  }

  // Product pixels on the canvas, after the single global color transform.
  const transformed = colorTransform({
    data: Buffer.from(scaledProduct),
    width: targetW,
    height: targetH,
    channels: 4,
  });
  if (transformed.width !== targetW || transformed.height !== targetH) {
    throw new Error("Global color transform must not change dimensions");
  }

  const productReference: RawImage = {
    data: Buffer.alloc(canvasW * canvasH * 4, 0),
    width: canvasW,
    height: canvasH,
    channels: 4,
  };
  const canvasMaskData = Buffer.alloc(canvasW * canvasH, 0);
  const cutoutAlphaData = Buffer.alloc(canvasW * canvasH, 0);
  const draftAlpha = Buffer.alloc(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const p = y * targetW + x;
      const src = p * 4;
      const idx = (y + offsetY) * canvasW + (x + offsetX);
      const dst = idx * 4;
      productReference.data[dst] = transformed.data[src];
      productReference.data[dst + 1] = transformed.data[src + 1];
      productReference.data[dst + 2] = transformed.data[src + 2];
      productReference.data[dst + 3] = 255;
      if (scaledMaskData[p] > 127) {
        canvasMaskData[idx] = 255;
      }
      cutoutAlphaData[idx] = scaledAlpha[p];
      // The draft never shows more product than the cutout itself has:
      // soft edges already read soft in the image the model harmonizes, and
      // the transparent (black after resize) surroundings stay out of it.
      draftAlpha[p] = Math.min(scaledMaskData[p], scaledAlpha[p]);
    }
  }
  const canvasMask: RawMask = nonZeroMask({ data: canvasMaskData, width: canvasW, height: canvasH });
  const cutoutAlpha: RawMask = { data: cutoutAlphaData, width: canvasW, height: canvasH };

  // Draft composite for the harmonization pass: product over the plate.
  const draft = blendOnto(plate, transformed, draftAlpha, targetW, targetH, offsetX, offsetY);
  const draftPng = await encodePng(draft);

  // Step c: harmonization pass for shadow and light spill only.
  const harmonizedRes = await provider.invoke<HarmonizeInput, ImageOutput>({
    task: HARMONIZE_TASK_NAME,
    input: { prompt: template.harmonizePrompt, png: draftPng, width: canvasW, height: canvasH },
    workspaceId: args.workspaceId,
    jobId: args.jobId,
    stepId: `${shot.id}:harmonize`,
  });
  costMicros += harmonizedRes.costMicros;
  // The harmonized image must stay in register with the product we paste
  // back at its planned offset: a different shape is rejected, never center
  // cropped (a crop would shift the shadow and light away from the product).
  const harmonizedDecoded = await decodeToRgba(harmonizedRes.output.png);
  if (aspectDrift(harmonizedDecoded.width, harmonizedDecoded.height, canvasW, canvasH) > HARMONIZE_ASPECT_TOLERANCE) {
    throw new HarmonizeAspectError(
      provider.name,
      { width: harmonizedDecoded.width, height: harmonizedDecoded.height },
      { width: canvasW, height: canvasH },
      costMicros,
    );
  }
  const harmonized = await stretchToCanvas(harmonizedDecoded, canvasW, canvasH);

  // Step d: paste the original product pixels back inside the eroded mask
  // with a feathered edge, so nothing the model repainted survives inside the
  // product (CLAUDE.md rule 3).
  //
  // Adaptive clamp: a fixed erosion radius annihilates the mask of thin
  // products (chains, cables, rings), after which nothing would be pasted
  // back and the product in the output would be entirely regenerated pixels.
  // Reduce the radius until the eroded mask keeps at least
  // MIN_PASTE_AREA_SHARE of the mask area; the floor of 0 pastes the full
  // mask.
  const maskArea = countNonZero(canvasMask.data);
  const minErodedArea = maskArea * MIN_PASTE_AREA_SHARE;
  let effectivePasteErodePx = Math.max(0, Math.floor(pasteErodePx));
  let eroded = await erode(canvasMask, effectivePasteErodePx);
  while (effectivePasteErodePx > 0 && countNonZero(eroded.data) < minErodedArea) {
    effectivePasteErodePx--;
    eroded = await erode(canvasMask, effectivePasteErodePx);
  }
  // The feather softens the edge outward from the eroded core, but only up
  // to the product mask (Update.md 2.4): past the mask the reference holds
  // the cutout's transparent surroundings, which read as a dark halo. Every
  // pixel of the eroded core stays at exactly 255 so the pure paste region
  // is byte identical, which is what fidelityReport asserts inside its
  // (further eroded) QC region. On the band between core and mask edge the
  // weight is multiplied by the cutout alpha (Update.md 2.5), so soft edges
  // blend with the scene the way the cutout says they should.
  const feathered = await feather(eroded, pasteFeatherPx);
  const pasteAlpha = pasteAlphaFor(eroded, feathered, canvasMask, cutoutAlpha);
  const finalRaw = blendCanvas(harmonized, productReference, pasteAlpha);

  return {
    png: await encodePng(finalRaw),
    finalRaw,
    canvasMask,
    pasteAlpha,
    cutoutAlpha,
    productReference,
    effectivePasteErodePx,
    costMicros,
  };
}

/**
 * Paste weight per canvas pixel: 255 on the eroded core (rule 3), 0 outside
 * the product mask (no halo), and feather times cutout alpha on the band in
 * between (soft edges).
 */
export function pasteAlphaFor(eroded: RawMask, feathered: RawMask, canvasMask: RawMask, cutoutAlpha: RawMask): RawMask {
  const n = eroded.data.length;
  if (feathered.data.length !== n || canvasMask.data.length !== n || cutoutAlpha.data.length !== n) {
    throw new Error("Paste alpha inputs must share one canvas size");
  }
  const out = Buffer.alloc(n, 0);
  for (let i = 0; i < n; i++) {
    if (eroded.data[i] !== 0) {
      out[i] = 255;
    } else if (canvasMask.data[i] !== 0) {
      out[i] = Math.round((feathered.data[i] * cutoutAlpha.data[i]) / 255);
    }
  }
  return { data: out, width: eroded.width, height: eroded.height };
}

/** Routing key of the harmonization pass. */
export const HARMONIZE_TASK_NAME = "harmonize";

/**
 * Largest relative aspect ratio drift accepted from a harmonize output.
 * Image models return their own native sizes (grid snapped, from a fixed
 * ratio table), so a small drift from the canvas shape is normal and the
 * output is stretched back to the canvas, which keeps it in register. The
 * nearest distinct ratio classes (4:5 and 3:4) differ by 6.25 percent, so a
 * 4 percent tolerance accepts snapping and rejects a different framing.
 */
export const HARMONIZE_ASPECT_TOLERANCE = 0.04;

/** Relative difference between the aspect ratio of w x h and of targetW x targetH. */
export function aspectDrift(width: number, height: number, targetW: number, targetH: number): number {
  if (width <= 0 || height <= 0 || targetW <= 0 || targetH <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(width / height / (targetW / targetH) - 1);
}

/**
 * A harmonize output came back in a different shape than the canvas. Not
 * retryable: the same provider answers the same draft with the same shape,
 * so the router moves straight to the next provider in the chain instead of
 * paying for repeats, and the breaker is not tripped for an answer that was
 * not an outage. costMicros is what the rejected output already cost.
 */
export class HarmonizeAspectError extends ProviderError {
  constructor(
    provider: string,
    readonly got: { width: number; height: number },
    readonly want: { width: number; height: number },
    readonly costMicros = 0,
  ) {
    super(
      `Harmonize output ${got.width}x${got.height} does not match the ${want.width}x${want.height} canvas shape`,
      provider,
      HARMONIZE_TASK_NAME,
      false,
    );
    this.name = "HarmonizeAspectError";
  }
}

/**
 * Throws HarmonizeAspectError when png's upright shape drifts from
 * width x height by more than HARMONIZE_ASPECT_TOLERANCE. Image bridges call
 * this inside the provider chain (see withHarmonizeAspectGuard) so the
 * router fails over to the next provider.
 */
export async function assertHarmonizeAspect(
  png: Buffer,
  width: number,
  height: number,
  provider: string,
  costMicros = 0,
): Promise<void> {
  const meta = await sharp(png).metadata();
  const got = { width: meta.autoOrient.width, height: meta.autoOrient.height };
  if (aspectDrift(got.width, got.height, width, height) > HARMONIZE_ASPECT_TOLERANCE) {
    throw new HarmonizeAspectError(provider, got, { width, height }, costMicros);
  }
}

/** A provider that may report its estimated cost (see @curvi/ai CostAwareProvider). */
type MaybeCostAware = Provider & { estimateCostMicros?(req: ProviderRequest): number | Promise<number> };

/**
 * Wraps an image provider so a harmonize output of the wrong shape fails
 * inside the provider chain, where the router can fail over to the next
 * provider, instead of after the chain returned. Scene plates pass through:
 * compositeShot crops a plate to the canvas on purpose, since the product is
 * placed after the plate. Cost estimates pass through, so cost capped calls
 * keep working.
 */
export function withHarmonizeAspectGuard(inner: MaybeCostAware): MaybeCostAware {
  const guarded: MaybeCostAware = {
    name: inner.name,
    kind: inner.kind,
    supports: (task: string) => inner.supports(task),
    invoke: async <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
      const res = await inner.invoke<TIn, TOut>(req);
      if (req.task === HARMONIZE_TASK_NAME) {
        const input = req.input as Partial<HarmonizeInput>;
        const output = res.output as Partial<ImageOutput>;
        if (input.width && input.height && output.png) {
          await assertHarmonizeAspect(output.png, input.width, input.height, inner.name, res.costMicros);
        }
      }
      return res;
    },
  };
  if (typeof inner.estimateCostMicros === "function") {
    const estimate = inner.estimateCostMicros.bind(inner);
    guarded.estimateCostMicros = (req: ProviderRequest) => estimate(req);
  }
  return guarded;
}

/** Count nonzero bytes in a binary mask buffer. */
function countNonZero(data: Buffer): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) {
      count++;
    }
  }
  return count;
}

/** Blend a placed product patch onto a canvas using its scaled mask as alpha. */
function blendOnto(
  canvas: RawImage,
  patch: RawImage,
  patchMask: Buffer,
  patchW: number,
  patchH: number,
  offsetX: number,
  offsetY: number,
): RawImage {
  const out: RawImage = {
    data: Buffer.from(canvas.data),
    width: canvas.width,
    height: canvas.height,
    channels: 4,
  };
  for (let y = 0; y < patchH; y++) {
    for (let x = 0; x < patchW; x++) {
      const m = patchMask[y * patchW + x];
      if (m === 0) {
        continue;
      }
      const src = (y * patchW + x) * 4;
      const dst = ((y + offsetY) * canvas.width + (x + offsetX)) * 4;
      if (m === 255) {
        out.data[dst] = patch.data[src];
        out.data[dst + 1] = patch.data[src + 1];
        out.data[dst + 2] = patch.data[src + 2];
      } else {
        for (let c = 0; c < 3; c++) {
          out.data[dst + c] = Math.round(
            (m * patch.data[src + c] + (255 - m) * out.data[dst + c]) / 255,
          );
        }
      }
      out.data[dst + 3] = 255;
    }
  }
  return out;
}

/** Blend two same size canvases with a full canvas alpha mask. */
function blendCanvas(base: RawImage, top: RawImage, alpha: RawMask): RawImage {
  const out: RawImage = {
    data: Buffer.from(base.data),
    width: base.width,
    height: base.height,
    channels: 4,
  };
  for (let i = 0; i < alpha.data.length; i++) {
    const a = alpha.data[i];
    if (a === 0) {
      continue;
    }
    const o = i * 4;
    if (a === 255) {
      out.data[o] = top.data[o];
      out.data[o + 1] = top.data[o + 1];
      out.data[o + 2] = top.data[o + 2];
    } else {
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = Math.round((a * top.data[o + c] + (255 - a) * out.data[o + c]) / 255);
      }
    }
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Scene plate to canvas size. The product is placed after the plate, so a
 * plate of another shape is deliberately center cropped to fill the canvas
 * (providers return their own native sizes); nothing is out of register.
 */
async function toCanvasRaw(png: Buffer, width: number, height: number): Promise<RawImage> {
  const decoded = await decodeToRgba(png);
  if (decoded.width === width && decoded.height === height) {
    return decoded;
  }
  const data = await sharp(decoded.data, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
  })
    .resize(width, height, { fit: "cover", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  return { data, width, height, channels: 4 };
}

/**
 * Harmonize output to canvas size. Its aspect was already checked to be
 * within HARMONIZE_ASPECT_TOLERANCE, so it is stretched (never cropped):
 * every point keeps its relative position and stays over the product.
 */
async function stretchToCanvas(decoded: RawImage, width: number, height: number): Promise<RawImage> {
  if (decoded.width === width && decoded.height === height) {
    return decoded;
  }
  const data = await sharp(decoded.data, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
  })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
  return { data, width, height, channels: 4 };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Retry policy per section 5.6, as a pure function so it is testable:
 * up to 3 attempts appending repairHint, then the fallback provider once,
 * then mark needs_review and release the credits.
 */
export type RetryDecision =
  | { action: "accept" }
  | { action: "retry"; nextAttempt: number; repairHint: string }
  | { action: "fallback_provider"; nextAttempt: number; repairHint: string }
  | { action: "needs_review" };

export function planRetry(attempt: number, verdict: QCVerdict): RetryDecision {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer, got ${attempt}`);
  }
  if (verdict.pass) {
    return { action: "accept" };
  }
  if (attempt < 3) {
    return { action: "retry", nextAttempt: attempt + 1, repairHint: verdict.repairHint };
  }
  if (attempt === 3) {
    return { action: "fallback_provider", nextAttempt: 4, repairHint: verdict.repairHint };
  }
  return { action: "needs_review" };
}
