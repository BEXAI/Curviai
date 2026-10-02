/**
 * The free white main image before signup, runner side
 * (docs/phases/PHASE_18.md P18-12). The web app (apps/web/src/lib/free-preview)
 * checks the switches and caps, ingests the upload and stores the files;
 * this runs, on that one photo, exactly what a pack's Amazon main image runs:
 *
 * 1. intake through the same llmJson path and recipe as a pack, metered on
 *    the platform spend key "preview" (no workspace exists yet), and the
 *    moderation gate on its flags (moderationBlockReasons);
 * 2. the cutout through the live cutout chain (packages/ai: timeout, retry,
 *    failover, breakers, caps and metering). No workspace is passed, so the
 *    R2 cutout cache is not touched; the provider's answer comes back for
 *    the web app to keep, and a claim seeds the new workspace's cache with it;
 * 3. the white main image from the real cutout with the pack's own renderer
 *    (renderOnBackground for amazon.main, no output options): product pixels
 *    are only moved and scaled, never regenerated (CLAUDE.md rule 3);
 * 4. the pack's checks on the encoded bytes: pixelChecks and fidelityReport
 *    against the placed cutout. A failed fidelity report never ships.
 *
 * Every provider call goes through @curvi/ai, and the spend comes back as
 * costMicros for the web app to book. Nothing here charges credits.
 */

import {
  callWithFailover,
  type CallResult,
  type CapsHook,
  type CutoutInput,
  type CutoutOutput,
} from "@curvi/ai";
import {
  decodeToRgba,
  encodePng,
  fidelityReport,
  IntakeAnswer,
  IntakeToolResult,
  pixelChecks,
  prepareWorkingSource,
  qcKindForSpec,
  rawToSharp,
  type CheckItem,
  type IntakeResult,
} from "@curvi/pipeline";
import { backgroundFor, productSizeFillFor } from "@curvi/pipeline/output-options";
import { CUTOUT_TASK } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import { cutoutCacheKey } from "./cutout-cache";
import { restoreSourceEdges } from "./cutout-edges";
import { ShotUnavailableError } from "./errors";
import { renderOnBackground } from "./live-deterministic";
import type { LiveProduct } from "./live-product";
import { alphaMask, segmentationRefusal, WORKING_SOURCE_MAX_PX } from "./live-runtime";
import {
  failureSpendMicros,
  llmJson,
  moderationBlockReasons,
  routedCallHooks,
  visionBlocks,
  wrapUserDescription,
  type PipelineDeps,
} from "./pipeline-runner";
import { trustedIntakeAnswer } from "./preflight-intake";
import { recipeFor, seedJobRecipes, type JobRecipes } from "./recipes";
import { encodeMaskPng, QC_EDGE_MARGIN_PX } from "./shot-outputs";

/** The platform spend key previews are metered on (no workspace yet). */
export const PREVIEW_SPEND_KEY = "preview";

/** The one channel a free preview is made for. */
export const PREVIEW_SPEC_ID = "amazon.main";

/** JPEG quality of the on page preview (not a deliverable). */
const PREVIEW_JPEG_QUALITY = 85;

export interface FreePreviewArgs {
  /** The preview row id; every metered call carries preview:{id} as its job. */
  previewId: string;
  /** The ingested upload: metadata stripped and upright (ingestImage). */
  bytes: Buffer;
  /** Longest side of the on page preview JPEG (seed freePreview). */
  previewLongSide: number;
}

/**
 * done: a white main image was made (its checks may still fail);
 * blocked: moderation or "not a sellable product";
 * failed: no clean cutout, or the render did not pass the fidelity check;
 * unavailable: intake or the cutout chain could not answer (down, out of
 * quota, a spend cap).
 */
export type FreePreviewStatus = "done" | "blocked" | "failed" | "unavailable";

export type FreePreviewReason =
  | "moderation"
  | "no_product"
  | "segmentation"
  | "render"
  | "fidelity"
  | "intake_unavailable"
  | "cutout_unavailable";

export interface FreePreviewFidelity {
  meanDeltaE: number;
  maxDeltaE: number;
  exactByteShare: number;
  threshold: number;
  pass: boolean;
}

export interface FreePreviewRun {
  status: FreePreviewStatus;
  reason: FreePreviewReason | null;
  /** What moderation named, for the stored blocked_reason. */
  moderation: string[];
  /** The cutout provider's answer for the upright working bytes, as
   * returned, so a claim can seed the workspace's cutout cache with it. */
  cutout: { bytes: Buffer; contentType: string } | null;
  /** The full size white main image as encoded for amazon.main. */
  main: { bytes: Buffer; format: string; width: number; height: number } | null;
  /** The on page preview, a JPEG of about previewLongSide pixels. */
  preview: Buffer | null;
  /** pixelChecks on the shipped file, and whether all passed. */
  checks: CheckItem[];
  checksPass: boolean;
  fillPct: number | null;
  fidelity: FreePreviewFidelity | null;
  /** Provider spend of every call above, in USD micros. */
  costMicros: number;
}

/**
 * Where the live runtime looks for a workspace's cached cutout of these
 * stored source bytes (LiveShotGenerator.readCachedCutout and
 * hasFreshUploadCutout: the workspace plus a sha256 of the upright working
 * copy). A claim copies the preview's cutout there, so the first pack of
 * the new workspace reads it instead of paying for a second cutout.
 */
export async function claimedCutoutCacheKey(workspaceId: string, sourceBytes: Buffer): Promise<string> {
  const working = await prepareWorkingSource(sourceBytes, WORKING_SOURCE_MAX_PX).catch(() => sourceBytes);
  return cutoutCacheKey(workspaceId, working, "png");
}

function emptyRun(): FreePreviewRun {
  return {
    status: "unavailable",
    reason: null,
    moderation: [],
    cutout: null,
    main: null,
    preview: null,
    checks: [],
    checksPass: false,
    fillPct: null,
    fidelity: null,
    costMicros: 0,
  };
}

async function recipesFor(deps: PipelineDeps, jobId: string): Promise<JobRecipes> {
  try {
    return deps.recipes ? await deps.recipes.forJob(jobId) : seedJobRecipes();
  } catch (err) {
    console.error(`[free-preview] could not assign recipes for ${jobId}; using the seed recipes`, err);
    return seedJobRecipes();
  }
}

/** Runs the preview. Never throws for a provider failure: those come back
 * as unavailable with whatever spend they billed. */
export async function runFreePreview(deps: PipelineDeps, args: FreePreviewArgs): Promise<FreePreviewRun> {
  const run = emptyRun();
  const jobId = `${PREVIEW_SPEND_KEY}:${args.previewId}`;
  // Anonymous previews have their own seeded daily cap before signup.
  const ai = { ...deps.ai, workspaceExpectedDailyMicros: undefined };

  // 1. Intake and moderation. visionBlocks only reads keys under the
  // workspace prefix it is given, so the photo gets a key under the spend
  // key; the loader hands back the bytes in memory, nothing is read from R2.
  const mediaKey = `ws/${PREVIEW_SPEND_KEY}/src/${args.previewId}`;
  const recipes = await recipesFor(deps, jobId);
  const recipe = recipeFor(recipes, "intake");
  let intake: IntakeResult | null = null;
  try {
    const blocks = await visionBlocks({ loadMedia: async () => args.bytes }, [{ mediaId: mediaKey }], PREVIEW_SPEND_KEY, 1);
    const answer = await llmJson<IntakeResult>(
      ai,
      recipe,
      IntakeAnswer,
      { images: [{ mediaId: mediaKey }], userDescription: wrapUserDescription(null) },
      { jobId, workspaceId: PREVIEW_SPEND_KEY, stepId: "preview:intake" },
      blocks,
      IntakeToolResult,
    );
    run.costMicros += answer.costMicros;
    intake = answer.value && answer.value.images.length === 1 ? trustedIntakeAnswer(answer.value, recipe) : null;
  } catch (err) {
    run.costMicros += failureSpendMicros(err);
    console.warn(`[free-preview] intake failed for ${args.previewId}`, err instanceof Error ? err.message : err);
  }
  if (!intake) {
    // Moderation is required before a cutout is paid for: fail closed.
    return { ...run, status: "unavailable", reason: "intake_unavailable" };
  }
  run.moderation = moderationBlockReasons(intake, null);
  if (run.moderation.length > 0) {
    return { ...run, status: "blocked", reason: "moderation" };
  }
  if (!intake.images[0].sellableProduct) {
    return { ...run, status: "blocked", reason: "no_product" };
  }

  // 2. The cutout, on the upright working copy a pack would send.
  const upright = await prepareWorkingSource(args.bytes, WORKING_SOURCE_MAX_PX).catch(() => args.bytes);
  const caps: CapsHook[] | undefined = ai.caps
    ? [
        { spendCaps: ai.caps, capKind: "pack", jobId },
        { spendCaps: ai.caps, capKind: "global_day" },
      ]
    : undefined;
  let cutout: CallResult<CutoutOutput>;
  try {
    cutout = await callWithFailover<CutoutInput, CutoutOutput>(
      ai.registry,
      ai.routing,
      ai.meter,
      ai.breakerStore,
      { task: CUTOUT_TASK, input: { imageBytes: upright, format: "png" }, jobId, stepId: `preview:${CUTOUT_TASK}` },
      { caps, ...routedCallHooks(ai) },
    );
  } catch (err) {
    run.costMicros += failureSpendMicros(err);
    console.warn(`[free-preview] cutout failed for ${args.previewId}`, err instanceof Error ? err.message : err);
    return { ...run, status: "unavailable", reason: "cutout_unavailable" };
  }
  run.costMicros += cutout.costMicros + cutout.billedFailureMicros;
  const cutoutBytes = Buffer.from(cutout.output.imageBytes);
  run.cutout = { bytes: cutoutBytes, contentType: cutout.output.contentType ?? "image/png" };

  const rgba = await restoreSourceEdges(await decodeToRgba(cutoutBytes), upright);
  const mask = alphaMask(rgba);
  if (segmentationRefusal(mask)) {
    return { ...run, status: "failed", reason: "segmentation" };
  }
  const product: LiveProduct = {
    productRgba: rgba,
    mask,
    productPng: await encodePng(rgba),
    maskPng: await encodeMaskPng(mask),
  };

  // 3. The white main image, exactly as a pack renders amazon.main.
  const spec = getSpec(PREVIEW_SPEC_ID);
  let still;
  try {
    still = await renderOnBackground(product, spec, backgroundFor(spec, null), productSizeFillFor(spec, null));
  } catch (err) {
    if (!(err instanceof ShotUnavailableError)) {
      console.error(`[free-preview] render failed for ${args.previewId}`, err);
    }
    return { ...run, status: "failed", reason: "render" };
  }

  // 4. The pack's checks, on the decoded shipped bytes.
  const shipped = await decodeToRgba(still.encoded.buffer);
  const fidelity = await fidelityReport(still.productReference, shipped, still.mask ?? mask, {
    kind: qcKindForSpec(spec),
    ...(still.fidelityErosion ? { erodePx: still.fidelityErosion.erodePx } : {}),
  });
  run.fidelity = {
    meanDeltaE: fidelity.meanDeltaE,
    maxDeltaE: fidelity.maxDeltaE,
    exactByteShare: fidelity.exactByteShare,
    threshold: fidelity.threshold,
    pass: fidelity.pass,
  };
  if (!fidelity.pass) {
    return { ...run, status: "failed", reason: "fidelity" };
  }
  const pixel = await pixelChecks(shipped, still.mask, spec, {
    encoded: { bytes: still.encoded.buffer.length, format: still.encoded.format },
    edgeMarginPx: QC_EDGE_MARGIN_PX,
  });
  run.checks = pixel.checks;
  run.checksPass = pixel.pass;
  run.fillPct = pixel.fillRatio !== null ? Math.round(pixel.fillRatio * 100) : null;
  run.main = {
    bytes: still.encoded.buffer,
    format: still.encoded.format,
    width: shipped.width,
    height: shipped.height,
  };
  run.preview = await rawToSharp(shipped)
    .resize({ width: args.previewLongSide, height: args.previewLongSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: PREVIEW_JPEG_QUALITY })
    .toBuffer();
  return { ...run, status: "done", reason: null };
}
