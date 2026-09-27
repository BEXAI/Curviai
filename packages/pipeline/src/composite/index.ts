/**
 * Generative compositing (CURVI_BUILD_PLAN.md section 5.5). The provider
 * paints the scene plate and harmonizes light and shadow, but the final step
 * pastes the original product pixels back inside the eroded mask with a 3 px
 * feather. Only a single global color transform may touch product pixels
 * (identity for now, hook exposed). CLAUDE.md rule 3.
 */
import sharp from "sharp";
import type { Provider } from "@curvi/ai";
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

/** Payload contract for image providers used by this pipeline. */
export interface ScenePlateInput {
  prompt: string;
  width: number;
  height: number;
}
export interface HarmonizeInput {
  prompt: string;
  png: Buffer;
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
  /** Erosion applied to the paste back mask edge. Default 3. */
  pasteErodePx?: number;
  /** Feather width at the paste back edge. Default 3. */
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
   * Canvas sized image holding the exact product pixels that must survive:
   * the scaled product placed at its offset (after the global color
   * transform). fidelityReport(productReference, finalRaw, canvasMask) proves
   * the paste back.
   */
  productReference: RawImage;
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
    pasteErodePx = 3,
    pasteFeatherPx = 3,
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
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const src = (y * targetW + x) * 4;
      const idx = (y + offsetY) * canvasW + (x + offsetX);
      const dst = idx * 4;
      productReference.data[dst] = transformed.data[src];
      productReference.data[dst + 1] = transformed.data[src + 1];
      productReference.data[dst + 2] = transformed.data[src + 2];
      productReference.data[dst + 3] = 255;
      if (scaledMaskData[y * targetW + x] > 127) {
        canvasMaskData[idx] = 255;
      }
    }
  }
  const canvasMask: RawMask = nonZeroMask({ data: canvasMaskData, width: canvasW, height: canvasH });

  // Draft composite for the harmonization pass: product over the plate.
  const draft = blendOnto(plate, transformed, scaledMaskData, targetW, targetH, offsetX, offsetY);
  const draftPng = await encodePng(draft);

  // Step c: harmonization pass for shadow and light spill only.
  const harmonizedRes = await provider.invoke<HarmonizeInput, ImageOutput>({
    task: "harmonize",
    input: { prompt: template.harmonizePrompt, png: draftPng },
    workspaceId: args.workspaceId,
    jobId: args.jobId,
    stepId: `${shot.id}:harmonize`,
  });
  costMicros += harmonizedRes.costMicros;
  const harmonized = await toCanvasRaw(harmonizedRes.output.png, canvasW, canvasH);

  // Step d: paste the original product pixels back inside the eroded mask
  // with a feathered edge, so nothing the model repainted survives inside the
  // product (CLAUDE.md rule 3).
  const eroded = await erode(canvasMask, pasteErodePx);
  const pasteAlpha = await feather(eroded, pasteFeatherPx);
  const finalRaw = blendCanvas(harmonized, productReference, pasteAlpha);

  return {
    png: await encodePng(finalRaw),
    finalRaw,
    canvasMask,
    productReference,
    costMicros,
  };
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
