/**
 * Live renderer for the seller's kept photo (PHASE_15 item 17): the stored
 * upload fitted to one channel spec through makeOriginalFit. Nothing is cut
 * out, generated or retouched; the only operations are geometry, a color
 * managed conversion to sRGB, flat added space and encoding (the fidelity
 * section).
 *
 * The rule 3 proof runs twice. Before encoding, the rendered canvas must
 * match buildProductReferenceFromEncoded byte for byte inside the placed
 * rectangle (fidelity exact), since both went through the same operations
 * and nothing else. After encoding, the runner checks the shipped decode
 * with the strict "main" row whatever the spec (fidelityKind "main"). A
 * photo that passes through unchanged is proven by sha256 instead, and
 * nothing is decoded.
 */

import {
  buildProductReferenceFromEncoded,
  fidelityReport,
  makeOriginalFit,
  SourceTooSmallError,
  type Shot,
} from "@curvi/pipeline";
import { backgroundFor, MAX_SOURCE_UPSCALE, SOURCE_TOO_SMALL_REASON, type ResolvedOutputOptions } from "@curvi/pipeline/output-options";
import { originalFit } from "@curvi/pipeline/seed";
import type { PackAssetTreatment } from "@curvi/pipeline/treatment";
import type { ChannelSpec } from "@curvi/specs";
import { ShotUnavailableError } from "./errors";
import type { StillRender } from "./live-product";
import { isWorkspaceObjectKey } from "./object-keys";
import { encodeForSpec, stillQcErosion } from "./shot-outputs";

/** Why a kept photo output went to review, in plain copy. */
export const ORIGINAL_NOT_LOADED = "Your photo could not be loaded for this channel, so it needs review.";
export const ORIGINAL_NOT_OURS = "This image does not point at one of this product's photos, so it needs review.";
export const ORIGINAL_DRIFTED =
  "Your photo could not be resized for this channel without changing it, so it needs review.";
export const ORIGINAL_NOT_PREPARED = "Your photo could not be prepared for this channel, so it needs review.";

/** The stored upload as bytes, loaded by R2 key. Null when it is gone. */
export type OriginalSourceLoader = (key: string) => Promise<Buffer | null>;

export interface OriginalShotInput {
  shot: Shot;
  spec: ChannelSpec;
  /** The job's resolved output options; absent means the defaults (auto fit, white). */
  output?: ResolvedOutputOptions | null;
  workspaceId: string;
  /** Loads the stored upload. The live generator passes a loader that keeps
   * the encoded bytes per job and photo, never the decoded pixels. */
  loadSource: OriginalSourceLoader | null;
  /** The stored copy was written again at upload (source_media.ingest). */
  reencodedAtUpload?: boolean;
  /** The fit renderer; makeOriginalFit unless a test passes a double that
   * drifts, to show the exact proof catches it. */
  fitOriginal?: typeof makeOriginalFit;
}

/** A kept photo rendered as pixels: a still the runner checks like any other. */
export interface OriginalRendered {
  kind: "rendered";
  still: StillRender & { treatment: PackAssetTreatment; fidelityKind: "main" };
}

/** A kept photo that ships as the stored bytes. */
export interface OriginalShippedUnchanged {
  kind: "unchanged";
  width: number;
  height: number;
  encoded: { buffer: Buffer; format: string };
  /** sha256 of the stored upload; the runner proves the delivered file matches it. */
  sha256: string;
  treatment: PackAssetTreatment;
}

export type OriginalShotRender = OriginalRendered | OriginalShippedUnchanged;

/**
 * Fits one kept photo to one spec: loads the stored upload (only from this
 * workspace's prefix), calls makeOriginalFit with the seller's fit and the
 * spec's background color for added space, then proves and encodes the
 * render. Throws ShotUnavailableError with SOURCE_TOO_SMALL_REASON when the
 * photo cannot reach the spec (the planner skips those; this is the last
 * guard), and ShotUnavailableError for a missing or foreign photo or a render
 * that drifted.
 */
export async function renderOriginalShot(input: OriginalShotInput): Promise<OriginalShotRender> {
  const { shot, spec, output } = input;
  if (!isWorkspaceObjectKey(input.workspaceId, shot.sourceMediaId)) {
    throw new ShotUnavailableError(ORIGINAL_NOT_OURS);
  }
  const source = input.loadSource ? await input.loadSource(shot.sourceMediaId) : null;
  if (!source || source.length === 0) {
    throw new ShotUnavailableError(ORIGINAL_NOT_LOADED);
  }
  let fitted: Awaited<ReturnType<typeof makeOriginalFit>>;
  try {
    fitted = await (input.fitOriginal ?? makeOriginalFit)(source, spec, {
      fit: output?.fit ?? "auto",
      padRgb: backgroundFor(spec, output).rgb,
      maxUpscale: MAX_SOURCE_UPSCALE,
      maxMegapixels: originalFit.maxMegapixels,
      ...(input.reencodedAtUpload ? { reencodedAtUpload: true } : {}),
    });
  } catch (err) {
    if (err instanceof SourceTooSmallError) {
      throw new ShotUnavailableError(SOURCE_TOO_SMALL_REASON);
    }
    throw err;
  }

  if (fitted.passthrough) {
    return {
      kind: "unchanged",
      width: fitted.width,
      height: fitted.height,
      encoded: { buffer: fitted.passthrough.bytes, format: fitted.passthrough.format },
      sha256: fitted.passthrough.sha256,
      treatment: fitted.treatment,
    };
  }

  const canvas = { width: fitted.width, height: fitted.height };
  const reference = await buildProductReferenceFromEncoded(source, fitted.placement, canvas);
  const erosion = await stillQcErosion(fitted.mask, fitted.treatment.scale ?? 1);
  // Before any encoding the render and its independent reference went
  // through the same operations only, so any difference is drift.
  const exact = await fidelityReport(reference, fitted.raw, fitted.mask, {
    kind: "main",
    exact: true,
    erodePx: erosion.erodePx,
  });
  if (!exact.pass) {
    console.error(`[live] kept photo ${shot.id} for ${spec.id} drifted before encoding: ${exact.issues.join(", ")}`);
    throw new ShotUnavailableError(ORIGINAL_DRIFTED);
  }
  const out = await encodeForSpec(fitted.raw, fitted.mask, reference, spec, {
    preferPng: fitted.preferPng,
    erodePx: erosion.erodePx,
    fidelityKind: "main",
  });
  return {
    kind: "rendered",
    still: {
      image: out.image,
      mask: fitted.mask,
      encoded: out.encoded,
      productReference: reference,
      fidelityErosion: erosion,
      treatment: fitted.treatment,
      fidelityKind: "main",
    },
  };
}
