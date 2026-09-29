/**
 * Preflight at upload, runner side (docs/phases/PHASE_14.md workstream 4 and
 * item 3.2). The web app calls this as soon as a photo is uploaded, before
 * any pack or credit hold exists. It runs, on that one photo, exactly what a
 * pack would run first:
 *
 * 1. intake, through the same llmJson path and recipe the runner uses, with
 *    the seller's note wrapped as untrusted data;
 * 2. the moderation gate on intake's flags (moderationBlockReasons);
 * 3. the product inventory: the whole photo cut out through the live
 *    runtime's inventory cutout (the R2 cutout cache keeps it, so the pack
 *    reuses it), split into pieces and decided by chooseInventoryTarget
 *    with the note, plus a thumbnail of each piece for the chooser when the
 *    photo holds 2 to 6 of them.
 *
 * Every provider call goes through @curvi/ai (metered, capped, with
 * failover); the spend comes back as costMicros for the web app to book on
 * the workspace. Nothing here charges or holds credits. The size gate and
 * the copy are the web app's (apps/web/src/lib/preflight).
 */

import {
  analyzeInventory,
  chooseInventoryTarget,
  IntakeResult,
  IntakeToolResult,
  itemLabel,
  matchProducts,
  noteSignals,
  pickerNumbering,
  PICKER_MAX_PIECES,
  PICKER_MIN_PIECES,
  renderCutoutPreview,
  renderPieceThumbnails,
  uprightSize,
  type InventoryDecision,
  type NormalizedBox,
} from "@curvi/pipeline";
import { isWorkspaceObjectKey } from "./object-keys";
import {
  failureSpendMicros,
  llmJson,
  moderationBlockReasons,
  visionBlocks,
  wrapUserDescription,
  type PipelineDeps,
} from "./pipeline-runner";
import { noteKey, type PreflightIntake } from "./preflight-intake";
import { recipeFor, seedJobRecipes, type JobRecipes } from "./recipes";

export { noteKey, PREFLIGHT_FRESH_MS, preflightFresh, type PreflightIntake } from "./preflight-intake";

/** Longest side of the cutout preview the form shows on the chosen color
 * (PHASE_15 P1): enough for the preview strip, far below any output. */
export const CUTOUT_PREVIEW_LONG_SIDE = 640;

export interface UploadPreflightArgs {
  /** A fresh id for this check: the job id every metered call carries. */
  preflightId: string;
  workspaceId: string;
  /** The uploaded photo's object key (ws/{workspaceId}/src/...). */
  mediaKey: string;
  note?: string | null;
  now?: Date;
}

/** One piece of the photo, numbered left to right as the chooser shows it. */
export interface PreflightItem {
  number: number;
  label: string;
  /** Normalized to 0..1 of the upright photo, like source_media.target_box. */
  box: NormalizedBox;
  areaShare: number;
  colorName: string;
  /** Whether the rules picked this piece for the pack. */
  featured: boolean;
}

export interface UploadPreflightRun {
  /** The photo was not in this workspace or could not be loaded. */
  missing: boolean;
  /** The upright photo's size, when it could be read. */
  photo: { width: number; height: number } | null;
  /** Intake's answer for the photo, null when the call failed or answered
   * out of shape. */
  intake: PreflightIntake | null;
  /** moderationBlockReasons on the intake flags. */
  moderation: string[];
  /** done: the inventory ran. unavailable: the cutout could not be made
   * (provider down, quota, not configured). skipped: a blocking intake
   * answer made it pointless. */
  cutout: "done" | "unavailable" | "skipped";
  /** Every piece, in chooser order; empty without an inventory. */
  items: PreflightItem[];
  /** The rule chooseInventoryTarget ended on, when the inventory ran. */
  rule: InventoryDecision["rule"] | null;
  /** One JPEG per item, in the same order, when the chooser is needed. */
  thumbnails: Buffer[];
  /** An alpha PNG of the one product the photo is for, at most
   * CUTOUT_PREVIEW_LONG_SIDE, drawn from the cutout already made (PHASE_15
   * P1 cutout preview); null when there is no cutout or no single product. */
  preview: Buffer | null;
  /** Provider spend of every call above, in USD micros. */
  costMicros: number;
}

async function recipesFor(deps: PipelineDeps, preflightId: string): Promise<JobRecipes> {
  try {
    return deps.recipes ? await deps.recipes.forJob(preflightId) : seedJobRecipes();
  } catch (err) {
    console.error(`[preflight] could not assign recipes for ${preflightId}; using the seed recipes`, err);
    return seedJobRecipes();
  }
}

export async function runUploadPreflight(deps: PipelineDeps, args: UploadPreflightArgs): Promise<UploadPreflightRun> {
  const run: UploadPreflightRun = {
    missing: false,
    photo: null,
    intake: null,
    moderation: [],
    cutout: "skipped",
    items: [],
    rule: null,
    thumbnails: [],
    preview: null,
    costMicros: 0,
  };
  const { preflightId, workspaceId, mediaKey } = args;
  if (!isWorkspaceObjectKey(workspaceId, mediaKey) || !deps.loadMedia) {
    return { ...run, missing: true };
  }
  const bytes = await deps.loadMedia(mediaKey).catch(() => null);
  if (!bytes || bytes.length === 0) {
    return { ...run, missing: true };
  }
  run.photo = await uprightSize(bytes);

  // 1. Intake, exactly as a pack runs it, on this one photo.
  const recipe = recipeFor(await recipesFor(deps, preflightId), "intake");
  const loadOnce = async () => bytes;
  const blocks = await visionBlocks({ loadMedia: loadOnce }, [{ mediaId: mediaKey }], workspaceId, 1);
  let intake: IntakeResult | null = null;
  try {
    const answer = await llmJson<IntakeResult>(
      deps.ai,
      recipe,
      IntakeResult,
      { images: [{ mediaId: mediaKey }], userDescription: wrapUserDescription(args.note) },
      { jobId: preflightId, workspaceId, stepId: "preflight:intake" },
      blocks,
      IntakeToolResult,
    );
    run.costMicros += answer.costMicros;
    intake = answer.value && answer.value.images.length === 1 ? answer.value : null;
  } catch (err) {
    run.costMicros += failureSpendMicros(err);
    console.warn(`[preflight] intake failed for ${preflightId}`, err instanceof Error ? err.message : err);
  }
  if (!intake) {
    return run;
  }
  const image = intake.images[0];
  run.intake = {
    image,
    ...(intake.sellerIntent ? { sellerIntent: intake.sellerIntent } : {}),
    noteKey: noteKey(args.note),
    recipe: { key: recipe.key, version: recipe.version },
    at: (args.now ?? new Date()).toISOString(),
  };

  // 2. The moderation gate, the same function the pack stops on.
  run.moderation = moderationBlockReasons(intake, null);
  if (run.moderation.length > 0 || image.screenshot === true || !image.sellableProduct) {
    return run;
  }

  // 3. The inventory, on the live runtime's cutout.
  const cut = deps.generator.inventoryCutout?.bind(deps.generator);
  if (!cut) {
    run.cutout = "unavailable";
    return run;
  }
  let cutout;
  try {
    const result = await cut({ jobId: preflightId, workspaceId, mediaId: mediaKey });
    run.costMicros += result.costMicros;
    cutout = result.cutout;
  } catch (err) {
    console.warn(`[preflight] inventory cutout failed for ${preflightId}`, err instanceof Error ? err.message : err);
    cutout = null;
  }
  if (!cutout) {
    run.cutout = "unavailable";
    return run;
  }
  run.cutout = "done";
  const inventory = analyzeInventory(cutout);
  const products = image.products ?? [];
  const decision = chooseInventoryTarget({
    objects: inventory.objects,
    products,
    signals: noteSignals(args.note, intake.sellerIntent ?? null),
  });
  run.rule = decision.rule;
  const match = matchProducts(inventory.objects, products);
  const order = pickerNumbering(inventory.objects).map((index) => inventory.objects[index]);
  run.items = order.map((object, i) => ({
    number: i + 1,
    label: itemLabel(object, products, match),
    box: object.box,
    areaShare: object.areaShare,
    colorName: object.color.name,
    featured: decision.featured.includes(object.index),
  }));
  // The cutout preview: the one product the pack is for, when the rules
  // settled on one (a photo that needs the chooser gets none).
  const featured = order.filter((object) => decision.featured.includes(object.index));
  const product = featured.length === 1 ? featured[0] : order.length === 1 ? order[0] : null;
  if (product) {
    run.preview = await renderCutoutPreview(cutout, product.pixelBox, { longSide: CUTOUT_PREVIEW_LONG_SIDE }).catch(
      (err: unknown) => {
        console.warn(`[preflight] could not draw the cutout preview for ${preflightId}`, err);
        return null;
      },
    );
  }
  if (order.length >= PICKER_MIN_PIECES && order.length <= PICKER_MAX_PIECES) {
    run.thumbnails = await renderPieceThumbnails(
      cutout,
      order.map((o) => o.pixelBox),
    ).catch((err: unknown) => {
      console.warn(`[preflight] could not draw the chooser thumbnails for ${preflightId}`, err);
      return [];
    });
  }
  return run;
}
