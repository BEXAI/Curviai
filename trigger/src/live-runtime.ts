/**
 * Live provider wiring. Reads provider API keys from env and upgrades the
 * demo registry and routing in place: Anthropic models per recipe task
 * (models and prices from the pipeline seed), the image scene plate chain
 * (Nano Banana 2, FLUX.2 pro, GPT Image 2 in failover order), fal BiRefNet
 * cutouts (FAL_KEY), and a LiveShotGenerator that runs the fidelity lock composite
 * flow against real providers. With no keys set nothing here activates and
 * the demo implementations keep working.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AnthropicLLMProvider,
  ASYNC_JOB_TIMEOUT_MARGIN_MS,
  BflFluxProvider,
  callWithFailover,
  CircuitBreaker,
  downloadBytes,
  FAL_API_KEY_ENV,
  type CallResult,
  type CapsHook,
  GeminiImageProvider,
  hasProviderErrorCode,
  OpenaiImageProvider,
  FalCutoutProvider,
  ProviderError,
  providerErrorsOf,
  signalOf,
  type BflFluxInput,
  type BflFluxOutput,
  type CostAwareProvider,
  type GeminiImageInput,
  type GeminiImageOutput,
  type OpenaiImageInput,
  type OpenaiImageOutput,
  type CutoutInput,
  type CutoutOutput,
  type Provider,
  type ProviderKind,
  type ProviderRegistry,
  type ProviderRequest,
  type ProviderResponse,
  type RoutingTable,
} from "@curvi/ai";
import {
  boxInCrop,
  buildProductReferenceFromEncoded,
  compositeShot,
  decodeToRgba,
  deriveQcErodePx,
  detectAlreadyWhite,
  fidelityReport,
  makeAlreadyWhite,
  pixelChecks,
  encodePng,
  HarmonizeAspectError,
  isolateTarget,
  isolateComponents,
  boxToPixels,
  prepareWorkingSource,
  rawToSharp,
  renderTemplateStill,
  TEMPLATE_STILL_TYPES,
  TEXT_TEMPLATE_TYPES,
  TemplateUnavailableError,
  cropToTarget,
  type NormalizedBox,
  type TargetCrop,
  type PixelRect,
  type TemplateStillType,
  type CompositeResult,
  type ImageOutput,
  type HarmonizeInput,
  type RawImage,
  type RawMask,
  type ScenePlateInput,
  withHarmonizeAspectGuard,
} from "@curvi/pipeline";
import {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  imageModelSeedRows,
  llmModelPrices,
  canvasDefaults,
  cutoutModelSeedRows,
  presets,
  recipeSeedRows,
  sceneDefaults,
  stillStyle,
  templates,
  type ImageModelSeedRow,
  type PresetKey,
} from "@curvi/pipeline/seed";
import { MAX_SOURCE_UPSCALE } from "@curvi/pipeline/output-options";
import { getSpec, listSpecs, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";

/** Long edge of the source photo the live shots work from: the largest
 * channel output (from the spec registry) plus headroom, so no spec is ever
 * upscaled and a 48 megapixel phone photo is not held as raw RGBA at full
 * size in every stage. */
export const WORKING_SOURCE_MAX_PX = Math.ceil(
  Math.max(...listSpecs().map((spec) => Math.max(spec.width ?? 0, spec.height ?? 0, spec.minWidth ?? 0, spec.minHeight ?? 0))) *
    1.25,
);
import { CUTOUT_CACHE_FRESH_MS, cutoutCacheKey, type CutoutCacheStore } from "./cutout-cache";
import { restoreSourceEdges } from "./cutout-edges";
import { ShotFailedAfterSpendError, ShotUnavailableError } from "./errors";
import { DETERMINISTIC_LIVE_TYPES, renderDeterministicShot } from "./live-deterministic";
import { ORIGINAL_NOT_PREPARED, renderOriginalShot } from "./live-original";
import type { LiveProduct, StillRender } from "./live-product";
import { isWorkspaceObjectKey } from "./object-keys";
import { llmModelProviderName, seedRecipe } from "./recipes";
import {
  failureSpendMicros,
  isSpendCapBlock,
  routedCallHooks,
  SHOT_CONTENT_BLOCKED,
  SHOT_SCENE_PAUSED,
  type PipelineDeps,
  type InventoryCutout,
  type InventoryCutoutArgs,
  type ProductTarget,
  type ShotGenerateArgs,
  type ShotGeneration,
  type ShotGenerator,
} from "./pipeline-runner";
import {
  canvasSizeFor,
  compositeQcErosion,
  encodeForSpec,
  encodeMaskPng,
  fitsSpecSize,
  maskArea,
  QC_EDGE_MARGIN_PX,
  resizeCanvasTo,
  RESIZE_KERNEL_REACH_PX,
  sameAspect,
  stillQcErosion,
  type QcErosion,
} from "./shot-outputs";

export type ReadEnv = (name: string) => string | undefined;

function readEnvDefault(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What wireLiveProviders activated, for generator selection and notices. */
export interface LiveWiring {
  llmLive: boolean;
  /** Scene plate chain in failover order; empty when no image key is set. */
  imageProviders: string[];
  /** Cutout chain in failover order; empty when FAL_KEY is not set. */
  cutoutProviders: string[];
  cutoutLive: boolean;
}

/**
 * Bridges one image adapter into the composite pipeline's scene plate
 * contract: ScenePlateInput in, ImageOutput png out. Each family speaks its
 * own request and response shape; the bridge normalizes both sides.
 */
export class ScenePlateBridge implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "image";
  /**
   * The router's per attempt timeout floor (Update.md 5.1): the inner
   * adapter's own floor (an async job's polling window plus margin) plus one
   * more margin for downloading the result, so the router never aborts a
   * paid job while its image is still downloading.
   */
  readonly minTimeoutMs: number;
  /** downloadBytes takes the fetch signature; the bridge's fetch is URL only. */
  private readonly downloadFetch: typeof fetch;

  constructor(
    private readonly inner: CostAwareProvider,
    private readonly family: ImageModelSeedRow["family"],
    name: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.name = name;
    this.minTimeoutMs = (inner.minTimeoutMs ?? 0) + ASYNC_JOB_TIMEOUT_MARGIN_MS;
    this.downloadFetch = ((input: string | URL | Request, init?: RequestInit) =>
      this.fetchFn(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
  }

  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === HARMONIZE_TASK;
  }

  estimateCostMicros(req: ProviderRequest): number | Promise<number> {
    return this.inner.estimateCostMicros?.(req) ?? 0;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const png =
      req.task === HARMONIZE_TASK
        ? await this.harmonize(req.input as unknown as HarmonizeInput, req)
        : await this.generate(req.input as unknown as ScenePlateInput, req);
    const output: ImageOutput = { png: png.buffer };
    return { output: output as TOut, costMicros: png.costMicros };
  }

  private async generate(
    input: ScenePlateInput,
    req: ProviderRequest,
  ): Promise<{ buffer: Buffer; costMicros: number }> {
    if (this.family === "gemini") {
      // Gemini picks its own shape unless asked; request the canvas aspect
      // so the plate is not center cropped out of register (Update.md 2.14).
      const res = await this.inner.invoke<GeminiImageInput, GeminiImageOutput>({
        ...req,
        input: { prompt: input.prompt, aspectRatio: nearestGeminiAspectRatio(input.width, input.height) },
      });
      const image = res.output.images[0];
      return { buffer: Buffer.from(image.dataBase64, "base64"), costMicros: res.costMicros };
    }
    if (this.family === "bfl") {
      const res = await this.inner.invoke<BflFluxInput, BflFluxOutput>({
        ...req,
        input: {
          prompt: input.prompt,
          width: clampToStep(input.width, 32, 320, 1440),
          height: clampToStep(input.height, 32, 320, 1440),
        },
      });
      const buffer = await this.download(res.output.imageUrl, req);
      return { buffer, costMicros: res.costMicros };
    }
    const res = await this.inner.invoke<OpenaiImageInput, OpenaiImageOutput>({
      ...req,
      input: { prompt: input.prompt, size: openaiSizeFor(input.width, input.height) },
    });
    const image = res.output.images[0];
    if (image.dataBase64) {
      return { buffer: Buffer.from(image.dataBase64, "base64"), costMicros: res.costMicros };
    }
    if (image.url) {
      const buffer = await this.download(image.url, req);
      return { buffer, costMicros: res.costMicros };
    }
    throw new ProviderError("OpenAI image response had neither data nor url", this.name, req.task, true);
  }

  /**
   * Light and shadow harmonization over the draft composite. Gemini and BFL
   * run an image to image edit; the OpenAI generations endpoint cannot edit,
   * so it passes the draft through unchanged at zero cost. The paste back
   * step after harmonization restores the product pixels either way.
   */
  private async harmonize(
    input: HarmonizeInput,
    req: ProviderRequest,
  ): Promise<{ buffer: Buffer; costMicros: number }> {
    if (this.family === "gemini") {
      const size = pngSize(input.png);
      const res = await this.inner.invoke<GeminiImageInput, GeminiImageOutput>({
        ...req,
        input: {
          prompt: input.prompt,
          images: [{ mimeType: "image/png", dataBase64: input.png.toString("base64") }],
          ...(size ? { aspectRatio: nearestGeminiAspectRatio(size.width, size.height) } : {}),
        },
      });
      const image = res.output.images[0];
      return { buffer: Buffer.from(image.dataBase64, "base64"), costMicros: res.costMicros };
    }
    if (this.family === "bfl") {
      const res = await this.inner.invoke<BflFluxInput, BflFluxOutput>({
        ...req,
        input: { prompt: input.prompt, inputImageBase64: input.png.toString("base64") },
      });
      const buffer = await this.download(res.output.imageUrl, req);
      return { buffer, costMicros: res.costMicros };
    }
    return { buffer: input.png, costMicros: 0 };
  }

  /** Downloads a result URL with the router's abort signal, so a timed out
   * attempt stops downloading too; failures map to ProviderErrors. */
  private async download(url: string, req: ProviderRequest): Promise<Buffer> {
    const bytes = await downloadBytes(this.downloadFetch, url, {
      provider: this.name,
      task: req.task,
      signal: signalOf(req),
    });
    return Buffer.from(bytes);
  }
}

/**
 * The provider registered for a scene plate bridge: the bridge behind the
 * harmonize shape guard (Update.md 2.14), so a harmonize output in another
 * shape than the canvas fails inside the provider chain and the router fails
 * over to the next image provider, instead of compositeShot refusing the
 * result after the chain returned. The bridge's timeout floor and cost
 * estimate stay visible to the router.
 */
export function guardScenePlate(bridge: ScenePlateBridge): CostAwareProvider {
  const guarded = withHarmonizeAspectGuard(bridge);
  return {
    name: guarded.name,
    kind: guarded.kind,
    supports: (task: string) => guarded.supports(task),
    invoke: <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> =>
      guarded.invoke<TIn, TOut>(req),
    estimateCostMicros: (req: ProviderRequest) => bridge.estimateCostMicros(req),
    minTimeoutMs: bridge.minTimeoutMs,
  };
}

function clampToStep(value: number, step: number, min: number, max: number): number {
  const clamped = Math.min(Math.max(value, min), max);
  return Math.max(min, Math.floor(clamped / step) * step);
}

/**
 * Aspect ratios Gemini image models accept in generationConfig.imageConfig
 * (checked against the Generative Language API discovery document, revision
 * 20260927, on 2026-09-28). Only the ratios every current image model takes;
 * the extreme 1:4 to 8:1 ratios are model specific and never needed here.
 */
const GEMINI_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/** The supported Gemini aspect ratio closest to width x height. */
export function nearestGeminiAspectRatio(width: number, height: number): string {
  const target = Math.log(width / height);
  let best: string = GEMINI_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of GEMINI_ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number);
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

/** Width and height from a PNG header, or null when the bytes are not a PNG. */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 0x89 || png.toString("ascii", 1, 4) !== "PNG") {
    return null;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Maps a canvas aspect ratio onto the sizes GPT Image accepts. */
function openaiSizeFor(width: number, height: number): string {
  if (width > height * 1.2) return "1536x1024";
  if (height > width * 1.2) return "1024x1536";
  return "1024x1024";
}

/**
 * Registers live providers for every configured API key and rewrites the
 * routing table entries they serve. Demo providers stay registered; tasks
 * without a live provider keep their demo route.
 */
export function wireLiveProviders(
  registry: ProviderRegistry,
  routing: RoutingTable,
  readEnv: ReadEnv = readEnvDefault,
  fetchFn: FetchLike = fetch,
): LiveWiring {
  const wiring: LiveWiring = { llmLive: false, imageProviders: [], cutoutProviders: [], cutoutLive: false };

  const anthropicKey = readEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    // One provider per priced model, serving every recipe task, so a recipe
    // row can list any of them in failover order and the runner hands that
    // order to the router per call (trigger/src/recipes.ts). The routing
    // table keeps the seed order as the default chain.
    const recipeTasks = [...new Set(recipeSeedRows.map((recipe) => recipe.key))];
    for (const [model, priceTable] of Object.entries(llmModelPrices)) {
      registry.register(
        new AnthropicLLMProvider({
          name: llmModelProviderName(model),
          tasks: recipeTasks,
          apiKey: anthropicKey,
          model,
          priceTable,
        }),
      );
    }
    for (const recipe of recipeSeedRows) {
      if (!recipe.active) continue;
      const chain = seedRecipe(recipe.stage)
        .models.filter((model) => llmModelPrices[model] !== undefined)
        .map(llmModelProviderName);
      if (chain.length > 0) {
        routing[recipe.key] = chain;
      }
    }
    wiring.llmLive = true;
  }

  const imageKeys: Record<ImageModelSeedRow["family"], string | undefined> = {
    gemini: readEnv("GEMINI_API_KEY"),
    bfl: readEnv("BFL_API_KEY"),
    openai: readEnv("OPENAI_API_KEY"),
  };
  for (const row of imageModelSeedRows) {
    const apiKey = imageKeys[row.family];
    if (!apiKey) continue;
    const config = {
      name: `${row.providerName}-api`,
      tasks: [SCENE_PLATE_TASK, HARMONIZE_TASK],
      apiKey,
      model: row.model,
      priceTable: { perImageMicros: row.perImageMicros },
    };
    const inner: CostAwareProvider =
      row.family === "gemini"
        ? new GeminiImageProvider(config)
        : row.family === "bfl"
          ? new BflFluxProvider(config)
          : new OpenaiImageProvider(config);
    registry.register(guardScenePlate(new ScenePlateBridge(inner, row.family, row.providerName, fetchFn)));
    wiring.imageProviders.push(row.providerName);
  }
  if (wiring.imageProviders.length > 0) {
    routing[SCENE_PLATE_TASK] = [...wiring.imageProviders];
    routing[HARMONIZE_TASK] = [...wiring.imageProviders];
  }

  // Cutouts run on fal (BiRefNet by default), in seed failover order. Every
  // shot starts from the cutout, so an exhausted or failing cutout provider
  // fails over to the next seeded one instead of failing every pack.
  const falKey = readEnv(FAL_API_KEY_ENV);
  if (falKey) {
    for (const row of cutoutModelSeedRows) {
      registry.register(
        new FalCutoutProvider({
          name: row.providerName,
          tasks: [CUTOUT_TASK],
          apiKey: falKey,
          modelId: row.model,
          modelParams: row.params,
          priceTable: { perCallMicros: row.perCallMicros },
          fetchFn: fetchFn as typeof fetch,
        }),
      );
      wiring.cutoutProviders.push(row.providerName);
    }
  }
  if (wiring.cutoutProviders.length > 0) {
    routing[CUTOUT_TASK] = [...wiring.cutoutProviders];
    wiring.cutoutLive = true;
  }

  return wiring;
}

/** Loads source media bytes by R2 object key. Null when the object is gone. */
export type MediaLoader = (sourceMediaId: string) => Promise<Buffer | null>;

/** R2 backed media loader; null when R2 credentials are not configured. */
export function makeR2MediaLoader(readEnv: ReadEnv = readEnvDefault): MediaLoader | null {
  const accountId = readEnv("R2_ACCOUNT_ID");
  const accessKeyId = readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SECRET_ACCESS_KEY");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const bucket = readEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return async (key: string) => {
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  };
}

/**
 * Refuses still shots that can never render, before the cutout is paid for.
 * The renderers repeat these checks; this only saves the spend.
 */
function precheckStill(shot: ShotGenerateArgs["shot"], label: string): void {
  const spec = getSpec(shot.channels[0]);
  const solidBackground = spec.background?.type === "solid";
  const needsText = TEXT_TEMPLATE_TYPES.has(shot.type);
  if (needsText && spec.textAllowed === false) {
    throw new ShotUnavailableError(`This channel does not allow text, so the ${label} image needs review.`);
  }
  if (needsText && !(shot.callouts ?? []).some((c) => c.trim().length > 0)) {
    throw new ShotUnavailableError(`The ${label} image has nothing to show yet, so it needs review.`);
  }
  if (solidBackground && (needsText || shot.type === "sweep_gray" || shot.type === "sweep_brand")) {
    throw new ShotUnavailableError(`This channel needs a plain background, so the ${label} image needs review.`);
  }
}

/** Maps a still renderer failure to a plain spoken, per shot refusal. */
function stillFailure(err: unknown, label: string, costMicros: number, args: ShotGenerateArgs): ShotUnavailableError {
  if (err instanceof ShotUnavailableError) {
    return new ShotUnavailableError(err.message, costMicros);
  }
  if (err instanceof TemplateUnavailableError) {
    console.warn(`[live] ${args.shot.id} template refused: ${err.message}`);
    return new ShotUnavailableError(`The ${label} image could not be laid out for this channel, so it needs review.`, costMicros);
  }
  console.error(`[live] ${args.shot.id} still render failed`, err);
  return new ShotUnavailableError(`The ${label} image could not be rendered, so it needs review.`, costMicros);
}

/**
 * Fidelity erosion for a still whose product was scaled up. The resize blends
 * product and background within the kernel's reach, measured in canvas pixels
 * that is the reach times the scale, so a small cutout blown up to channel
 * size would otherwise fail on its edge band alone. Undefined (the default
 * erosion) when the product was not scaled up.
 */
export function upscaleErodePx(cutoutMask: RawMask, placedMask: RawMask | null): number | undefined {
  if (!placedMask) return undefined;
  const scale = placementScale(cutoutMask, placedMask);
  if (scale === undefined || scale <= 1) return undefined;
  return Math.max(deriveQcErodePx(), Math.ceil(RESIZE_KERNEL_REACH_PX * scale) + 1);
}

/** Linear scale from the cutout to its placement, estimated from mask areas. */
function placementScale(cutoutMask: RawMask, placedMask: RawMask): number | undefined {
  const source = maskArea(cutoutMask);
  const placed = maskArea(placedMask);
  if (source === 0 || placed === 0) return undefined;
  return Math.sqrt(placed / source);
}

/**
 * Fidelity check region for a still whose renderer does not report its
 * placement (the template stills): the scale is estimated from the mask
 * areas, then sized like any other still, with the thin product floor.
 */
async function stillErosionFromMasks(cutoutMask: RawMask, placedMask: RawMask | null): Promise<QcErosion | undefined> {
  if (!placedMask) return undefined;
  return stillQcErosion(placedMask, placementScale(cutoutMask, placedMask) ?? 1);
}

/** Mask from the alpha channel of an RGBA cutout. */
export function alphaMask(image: RawImage): RawMask {
  const data = Buffer.alloc(image.width * image.height, 0);
  for (let i = 0; i < image.width * image.height; i++) {
    data[i] = image.data[i * 4 + 3] > 8 ? 255 : 0;
  }
  return { data, width: image.width, height: image.height };
}

/**
 * Above this share of the photo, a cutout is taken as a failed segmentation:
 * the background came back as product, and pasting it would ship the photo
 * rectangle as the product (Update.md 2.13).
 */
export const MAX_CUTOUT_COVERAGE = 0.95;

const SEGMENTATION_FAILED =
  "We could not separate the product from its background in this photo, so this shot needs review.";
const NO_PRODUCT_FOUND = "The cutout found no product in this photo, so this shot needs review.";
/** Every image provider returned the lighting pass in another shape than
 * the canvas, so the product could not be placed back in register. */
export const HARMONIZE_SHAPE_REFUSED =
  "The image service returned this scene in the wrong shape, so this shot needs review.";
const SPEND_CAP_REACHED = "Spend cap reached before this shot could be generated.";

/**
 * Why a cutout mask cannot be used, or null when it can: empty, covering
 * almost the whole photo, or touching all four photo borders (the background
 * was kept, so the product was not separated).
 */
export function segmentationRefusal(mask: RawMask): string | null {
  const { data, width, height } = mask;
  const area = maskArea(mask);
  if (area === 0) {
    return NO_PRODUCT_FOUND;
  }
  if (area / (width * height) > MAX_CUTOUT_COVERAGE) {
    return SEGMENTATION_FAILED;
  }
  const rowTouches = (y: number): boolean => {
    for (let x = 0; x < width; x++) if (data[y * width + x] >= 128) return true;
    return false;
  };
  const columnTouches = (x: number): boolean => {
    for (let y = 0; y < height; y++) if (data[y * width + x] >= 128) return true;
    return false;
  };
  if (rowTouches(0) && rowTouches(height - 1) && columnTouches(0) && columnTouches(width - 1)) {
    return SEGMENTATION_FAILED;
  }
  return null;
}

/** Shot refusal when the product the seller picked touches another product
 * in the photo, so the two cannot be separated. The web app maps it to
 * seller copy. */
export const PRODUCT_TOUCHING =
  "The product you picked touches another product in this photo, so we could not separate them and this shot was not charged.";
/** Shot refusal when the photo could not be cropped to the product. */
export const ISOLATION_FAILED = "We could not find the product you picked in this photo, so this shot needs review.";

/**
 * Keeps only the cutout pieces overlapping the target box (mapped into the
 * crop, at whatever size the cutout came back) and zeroes the rest, or a
 * refusal when the target cannot be told apart from another product.
 */
export function isolateCutout(
  cutout: RawImage,
  target: ProductTarget,
  crop: TargetCrop,
): { image: RawImage; refusal?: undefined } | { image?: undefined; refusal: string } {
  const frame = { width: cutout.width, height: cutout.height };
  const targetRect = target.box ? boxInCrop(target.box, crop.source, crop.rect, frame) : null;
  if (!targetRect) {
    return { refusal: ISOLATION_FAILED };
  }
  const others = target.others
    .map((other) => boxInCrop(other.box, crop.source, crop.rect, frame))
    .filter((rect): rect is PixelRect => rect !== null);
  const result = isolateTarget(cutout, targetRect, others);
  if (result.touching) {
    return { refusal: PRODUCT_TOUCHING };
  }
  return { image: result.image };
}

/**
 * Keeps exactly the cutout pieces the product inventory featured (at their
 * boxes, normalized to the whole cutout) and zeroes every other piece, or a
 * refusal: the featured piece holds another product too (touching), or no
 * piece of this cutout sits at a featured box.
 */
export function isolateInventoryTarget(
  cutout: RawImage,
  target: ProductTarget,
): { image: RawImage; refusal?: undefined } | { image?: undefined; refusal: string } {
  if (target.touching) {
    return { refusal: PRODUCT_TOUCHING };
  }
  const toPixels = (box: NormalizedBox) => boxToPixels(box, cutout.width, cutout.height);
  const result = isolateComponents(
    cutout,
    (target.keep ?? []).map(toPixels),
    target.others.map((other) => toPixels(other.box)),
  );
  if (result.missing || result.kept === 0) {
    return { refusal: ISOLATION_FAILED };
  }
  return { image: result.image };
}

const COMPOSITE_METHODS: ReadonlySet<string> = new Set(["composite_generate", "edit_generate"]);

export interface LiveShotGeneratorOptions {
  ai: PipelineDeps["ai"];
  wiring: LiveWiring;
  /** Null when R2 is not configured; every shot is then unavailable. */
  loadMedia: MediaLoader | null;
  /**
   * The upload's cutout cache (PHASE_14 workstream 4), the same store the
   * cutout providers are wrapped with, built once in runtime.ts. Read
   * directly, never through the router: the inventory of a kept photo, the
   * already white check (control 7) and every cutout before it calls a
   * provider, so a photo checked at upload still renders while the cutout
   * breaker is open (PHASE_15 item 16). A cache read is not a provider call.
   */
  cutoutCache?: CutoutCacheStore | null;
  /** Clock for the cache's freshness; tests pin it. */
  now?: () => Date;
}

/** Shot types that make a white required file from a kept photo, which the
 * already white path may make from the photo itself (control 7). */
const MADE_WHITE_TYPES: ReadonlySet<string> = new Set(["amazon_main", "alt_angle_white"]);

/**
 * A cut out product plus what it cost; cached per job and source photo. A
 * cutout that cannot be used is cached too (as its refusal), so every shot
 * of that photo goes to needs review without paying for another cutout.
 */
interface ProductLoad {
  product: LiveProduct | null;
  refusal?: string;
  costMicros: number;
}

/** A whole working photo cut out, cached per job and photo and shared by
 * the product inventory and every shot of the photo. */
interface CutoutLoad {
  rgba: RawImage;
  costMicros: number;
}

/** A cutout call that failed after it was billed; the first shot to see the
 * failure books the spend, the others waiting on the same load do not. */
class ProductLoadError extends Error {
  claimed = false;
  constructor(
    readonly original: unknown,
    readonly billedMicros: number,
  ) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
    this.name = "ProductLoadError";
  }
}

/** Provider spend of one generate or derive call, across every provider call
 * it made: the cutout it claimed, scene plates, harmonization, and the
 * billed attempts of any chain that failed. */
interface AttemptSpend {
  micros: number;
}

type CapsHooks = CapsHook[] | undefined;

/**
 * Real shot generator. Every still starts from the seller's own photo: load
 * it from R2, cut the product out through the cutout chain (once per job and photo,
 * shared by every shot and attempt that uses it), then
 * - composite and edit methods generate a scene plate through the image
 *   chain and paste the original product pixels back via compositeShot;
 * - deterministic methods (white main image, alt angles, cutout, sweeps,
 *   collection thumb) place the real pixels with the whiten helpers;
 * - template methods (infographic, dimensions, in the box, comparison, A+
 *   banner, social crops)
 *   place the real pixels on a seeded background with rendered text.
 * No path regenerates product pixels (CLAUDE.md rule 3).
 *
 * A composite aimed at several channels is generated once for its primary
 * channel; deriveForSpec then builds the other channels' files from that
 * result with no new provider spend (Update.md 2.11).
 *
 * Anything it cannot produce for real (video and avatar methods, template
 * types without the data they need, a missing or foreign source photo, a
 * failed segmentation, a provider that is not configured, a spend cap block)
 * throws ShotUnavailableError: the shot goes to needs review with its
 * credits released. It never substitutes demo output.
 *
 * Every provider call reserves its estimated cost against the per asset,
 * pack and global day caps before it runs (plan 4.4).
 */
export class LiveShotGenerator implements ShotGenerator {
  private readonly products = new Map<string, Promise<ProductLoad>>();
  private readonly productCostClaimed = new Set<string>();
  private readonly cutouts = new Map<string, Promise<CutoutLoad>>();
  private readonly cutoutCosts = new Map<string, number>();
  private readonly cutoutCostClaimed = new Set<string>();
  private readonly logos = new Map<string, Promise<Buffer | null>>();
  /** Stored uploads of kept photos, as encoded bytes per job and photo,
   * never as RGBA (PHASE_15 memory section). */
  private readonly sources = new Map<string, Promise<Buffer | null>>();

  constructor(private readonly opts: LiveShotGeneratorOptions) {}

  async generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    const spend: AttemptSpend = { micros: 0 };
    try {
      return await this.generateLive(args, spend);
    } catch (err) {
      throw attemptFailure(err, spend);
    }
  }

  /**
   * This shot's file for another channel, built from an accepted composite
   * without calling any image provider. A size the source already meets is
   * only re-encoded for the new spec. With the same aspect ratio the finished
   * scene is scaled to the new size and the original product pixels are
   * pasted back at that size through the same composite step, so the product
   * is exact again at the new size. A different aspect ratio is re-framed
   * around the product and checked with a wider erosion.
   */
  async deriveForSpec(args: ShotGenerateArgs, from: ShotGeneration, specId: string): Promise<ShotGeneration> {
    const spend: AttemptSpend = { micros: 0 };
    try {
      return await this.deriveLive(args, from, specId, spend);
    } catch (err) {
      throw attemptFailure(err, spend);
    }
  }

  private async deriveLive(
    args: ShotGenerateArgs,
    from: ShotGeneration,
    specId: string,
    spend: AttemptSpend,
  ): Promise<ShotGeneration> {
    const spec = getSpec(specId);
    const source = from.canvas ?? from.image;
    if (!from.mask || !from.productReference) {
      throw new ShotUnavailableError("This image could not be prepared for another channel, so it needs review.");
    }
    const erosion: QcErosion = {
      erodePx: from.fidelityErodePx ?? deriveQcErodePx(),
      floorPx: from.fidelityErodeFloorPx ?? from.fidelityErodePx ?? deriveQcErodePx(),
    };
    const shot = { ...args.shot, channels: [specId] };

    if (fitsSpecSize(spec, source.width, source.height)) {
      const out = await encodeForSpec(source, from.mask, from.productReference, spec, {
        preferPng: true,
        erodePx: erosion.erodePx,
      });
      return {
        image: out.image,
        mask: from.mask,
        productReference: from.productReference,
        encoded: out.encoded,
        costMicros: spend.micros,
        spendReserved: true,
        fidelityRequired: true,
        fidelityErodePx: erosion.erodePx,
        fidelityErodeFloorPx: erosion.floorPx,
        canvas: source,
      };
    }

    const target = canvasSizeFor(spec);
    if (sameAspect(source, target)) {
      const product = await this.productFor({ ...args, shot }, this.capsFor(args), spend);
      const plate = await rawToSharp(source)
        .resize(target.width, target.height, { fit: "fill", kernel: "lanczos3" })
        .png()
        .toBuffer();
      // Pass through provider: the scaled finished scene is the plate and
      // harmonization returns its input, so nothing is generated or paid.
      const passThrough: Provider = {
        name: "derived-scene",
        kind: "image",
        supports: (task) => task === SCENE_PLATE_TASK || task === HARMONIZE_TASK,
        invoke: async <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
          const png = req.task === HARMONIZE_TASK ? (req.input as unknown as HarmonizeInput).png : plate;
          const output: ImageOutput = { png };
          return { output: output as TOut, costMicros: 0 };
        },
      };
      const { scenePrompt, fill } = this.compositeTemplate(shot, spec, args.repairHint);
      const result = await compositeShot({
        productRgba: product.productRgba,
        mask: product.mask,
        provider: passThrough,
        shot,
        template: {
          width: target.width,
          height: target.height,
          scenePrompt,
          harmonizePrompt: templates.harmonize_nano_banana2(),
          placement: { fill },
        },
        workspaceId: args.workspaceId,
        jobId: args.jobId,
      });
      return this.finishComposite(result, spec, spend.micros, true);
    }

    const resized = await resizeCanvasTo(source, from.mask, from.productReference, erosion, target);
    const out = await encodeForSpec(resized.image, resized.mask, resized.productReference, spec, {
      preferPng: true,
      erodePx: resized.erosion.erodePx,
    });
    return {
      image: out.image,
      mask: resized.mask,
      productReference: resized.productReference,
      encoded: out.encoded,
      costMicros: spend.micros,
      spendReserved: true,
      fidelityRequired: true,
      fidelityErodePx: resized.erosion.erodePx,
      fidelityErodeFloorPx: resized.erosion.floorPx,
      canvas: resized.image,
    };
  }

  /** True when every configured image provider's breaker is open. */
  private async sceneChainOpen(): Promise<boolean> {
    const names = this.opts.wiring.imageProviders;
    if (names.length === 0) return false;
    const breaker = new CircuitBreaker(this.opts.ai.breakerStore);
    try {
      const open = await Promise.all(names.map((name) => breaker.isOpen(name)));
      return open.every(Boolean);
    } catch {
      // A breaker store that cannot be read never blocks a shot by itself.
      return false;
    }
  }

  private capsFor(args: ShotGenerateArgs): CapsHooks {
    const caps = this.opts.ai.caps;
    return caps
      ? [
          { spendCaps: caps, capKind: "image_asset", assetId: args.shot.id },
          { spendCaps: caps, capKind: "pack", jobId: args.jobId },
          { spendCaps: caps, capKind: "global_day" },
        ]
      : undefined;
  }

  /**
   * The whole upright working photo of a job cut out, once per job and
   * photo: the product inventory and every shot and attempt of the photo
   * share it. A failed call is not cached, so the next caller tries again;
   * a billed failure is booked once (ProductLoadError).
   */
  private fullCutout(
    jobId: string,
    workspaceId: string,
    mediaId: string,
    caps: CapsHooks,
    stepId: string,
    label: string,
  ): Promise<CutoutLoad> {
    const { ai, loadMedia } = this.opts;
    const key = `${jobId}:${mediaId}`;
    let pending = this.cutouts.get(key);
    if (!pending) {
      pending = (async (): Promise<CutoutLoad> => {
        const source = loadMedia ? await loadMedia(mediaId) : null;
        if (!source || source.length === 0) {
          throw new ShotUnavailableError(`The source photo for the ${label} could not be loaded.`);
        }
        // Phone photos often carry their rotation only as an EXIF tag, which
        // the cutout service ignores: send the pixels upright (Update.md
        // 7.8), downscaled to working size so the cutout and every raw copy
        // after it stay bounded. Bytes sharp cannot read go as they are; the
        // service may.
        const upright = await prepareWorkingSource(source, WORKING_SOURCE_MAX_PX).catch(() => source);
        // The upload's cached answer for these exact bytes first: no provider
        // call, so an open cutout breaker never stops a photo checked at
        // upload (PHASE_15 item 16).
        const cached = await this.readCachedCutout(workspaceId, upright);
        if (cached) {
          console.info(`[live] job ${jobId} ${label} cutout read from the upload cache`);
          this.cutoutCosts.set(key, 0);
          return { rgba: await restoreSourceEdges(cached, upright), costMicros: 0 };
        }
        let cutout: CallResult<CutoutOutput>;
        try {
          cutout = await callWithFailover<CutoutInput, CutoutOutput>(
            ai.registry,
            ai.routing,
            ai.meter,
            ai.breakerStore,
            {
              task: CUTOUT_TASK,
              input: { imageBytes: upright, format: "png" },
              workspaceId,
              jobId,
              stepId,
            },
            { caps, ...routedCallHooks(ai) },
          );
        } catch (err) {
          const billed = failureSpendMicros(err);
          throw billed > 0 ? new ProductLoadError(err, billed) : err;
        }
        const costMicros = cutout.costMicros + cutout.billedFailureMicros;
        this.cutoutCosts.set(key, costMicros);
        // Product pixels keep the photo's own colors, border included.
        const decoded = await decodeToRgba(Buffer.from(cutout.output.imageBytes));
        return { rgba: await restoreSourceEdges(decoded, upright), costMicros };
      })();
      this.cutouts.set(key, pending);
      pending.catch(() => this.cutouts.delete(key));
    }
    return pending;
  }

  /**
   * The upload's cached cutout of these exact working bytes, decoded, when a
   * fresh one exists; null on a miss, without a cache, or when it cannot be
   * read. Never calls a provider.
   */
  private async readCachedCutout(workspaceId: string, working: Buffer): Promise<RawImage | null> {
    const store = this.opts.cutoutCache;
    if (!store) return null;
    const key = cutoutCacheKey(workspaceId, working, "png");
    const hit = await store.get(key).catch(() => null);
    const now = (this.opts.now ?? (() => new Date()))().getTime();
    if (!hit || now - hit.storedAt.getTime() >= CUTOUT_CACHE_FRESH_MS) return null;
    return decodeToRgba(hit.bytes).catch(() => null);
  }

  /** The upload's cached cutout of a stored photo, prepared the way the
   * cutout was sent, so the key matches what the preflight stored. */
  private async cachedCutoutOf(workspaceId: string, source: Buffer): Promise<RawImage | null> {
    const working = await prepareWorkingSource(source, WORKING_SOURCE_MAX_PX).catch(() => source);
    return this.readCachedCutout(workspaceId, working);
  }

  /** A stored upload as encoded bytes, loaded once per job and photo. */
  private sourceFor(jobId: string, mediaId: string): Promise<Buffer | null> {
    const { loadMedia } = this.opts;
    if (!loadMedia) return Promise.resolve(null);
    const key = `${jobId}:${mediaId}`;
    let pending = this.sources.get(key);
    if (!pending) {
      pending = loadMedia(mediaId).catch(() => null);
      this.sources.set(key, pending);
      void pending.then((bytes) => {
        if (!bytes) this.sources.delete(key);
      });
    }
    return pending;
  }

  /**
   * The rect of this job's whole photo cutout, when one was already made
   * (by the product inventory) at the size the crop was taken from; null
   * otherwise, and when that cutout failed. The pixels are copied as they
   * are, so the product stays byte identical (rule 3).
   */
  private async cachedFullCutoutCrop(
    key: string,
    source: { width: number; height: number },
    rect: PixelRect,
  ): Promise<RawImage | null> {
    const pending = this.cutouts.get(key);
    if (!pending) return null;
    let load: CutoutLoad;
    try {
      load = await pending;
    } catch {
      return null;
    }
    const { rgba } = load;
    if (rgba.width !== source.width || rgba.height !== source.height) return null;
    if (rect.left < 0 || rect.top < 0 || rect.left + rect.width > rgba.width || rect.top + rect.height > rgba.height) {
      return null;
    }
    const data = Buffer.alloc(rect.width * rect.height * 4);
    for (let y = 0; y < rect.height; y++) {
      const from = ((rect.top + y) * rgba.width + rect.left) * 4;
      rgba.data.copy(data, y * rect.width * 4, from, from + rect.width * 4);
    }
    return { data, width: rect.width, height: rect.height, channels: 4 };
  }

  /** The whole photo cutout's cost the first time it is claimed, else 0. */
  private claimCutoutCost(key: string): number {
    const cost = this.cutoutCosts.get(key);
    if (cost === undefined || this.cutoutCostClaimed.has(key)) {
      return 0;
    }
    this.cutoutCostClaimed.add(key);
    return cost;
  }

  /**
   * The whole photo cut out for the product inventory (docs/phases/
   * PHASE_13.md), reserved against the pack and day caps. The shots of the
   * photo reuse it, so the pack pays for one cutout per photo. Never throws:
   * a photo it cannot cut out (not configured, not this workspace's, a
   * provider failure, a spend cap, an unusable mask) comes back with no
   * cutout and keeps the intake only path.
   */
  async inventoryCutout(args: InventoryCutoutArgs): Promise<InventoryCutout> {
    const { wiring, loadMedia, ai } = this.opts;
    if (args.cacheOnly) {
      return this.cachedInventoryCutout(args);
    }
    if (!wiring.cutoutLive || !loadMedia || !isWorkspaceObjectKey(args.workspaceId, args.mediaId)) {
      return { cutout: null, costMicros: 0 };
    }
    const caps: CapsHooks = ai.caps
      ? [
          { spendCaps: ai.caps, capKind: "pack", jobId: args.jobId },
          { spendCaps: ai.caps, capKind: "global_day" },
        ]
      : undefined;
    const key = `${args.jobId}:${args.mediaId}`;
    try {
      const load = await this.fullCutout(
        args.jobId,
        args.workspaceId,
        args.mediaId,
        caps,
        `inventory:${CUTOUT_TASK}`,
        "product inventory",
      );
      const costMicros = this.claimCutoutCost(key);
      return { cutout: segmentationRefusal(alphaMask(load.rgba)) ? null : load.rgba, costMicros };
    } catch (err) {
      if (err instanceof ProductLoadError && !err.claimed) {
        err.claimed = true;
        return { cutout: null, costMicros: err.billedMicros };
      }
      console.warn(`[live] job ${args.jobId} inventory cutout failed`, err);
      return { cutout: null, costMicros: 0 };
    }
  }

  /**
   * The inventory cutout of a photo no shot cuts out (a kept photo), from
   * the upload's cache only: the upright working bytes, their cache key,
   * one store read. Never through the router and never paid; a miss leaves
   * the photo's inventory empty.
   */
  private async cachedInventoryCutout(args: InventoryCutoutArgs): Promise<InventoryCutout> {
    if (!this.opts.loadMedia || !isWorkspaceObjectKey(args.workspaceId, args.mediaId)) {
      return { cutout: null, costMicros: 0 };
    }
    try {
      const source = await this.sourceFor(args.jobId, args.mediaId);
      const cutout = source && source.length > 0 ? await this.cachedCutoutOf(args.workspaceId, source) : null;
      return { cutout: cutout && !segmentationRefusal(alphaMask(cutout)) ? cutout : null, costMicros: 0 };
    } catch (err) {
      console.warn(`[live] job ${args.jobId} cached inventory cutout could not be read`, err);
      return { cutout: null, costMicros: 0 };
    }
  }

  /**
   * The cut out product for this shot's source photo. The cutout call runs
   * once per job and photo; the first caller to use it (the product
   * inventory, or the first shot) books its cost, every later shot and retry
   * reuses it for free. A failed load is not cached, so the next attempt
   * tries again (its billed spend is booked once); an unusable cutout is
   * cached as a refusal, so the photo is never cut out twice only to be
   * refused again.
   *
   * A target the inventory chose (keep) is isolated on the whole photo's
   * cutout: exactly its pieces are kept, byte identical, the rest zeroed.
   * An intake only target (a box, no inventory) still crops the photo to the
   * box before its own cutout, as before the inventory.
   */
  private async productFor(args: ShotGenerateArgs, caps: CapsHooks, spend: AttemptSpend): Promise<LiveProduct> {
    const { ai, loadMedia } = this.opts;
    const label = args.shot.type.replaceAll("_", " ");
    // Source photos live under the workspace's own prefix; anything else
    // (a planner hallucination, another tenant's key, a traversal) is never
    // loaded (Update.md 4.1).
    if (!isWorkspaceObjectKey(args.workspaceId, args.shot.sourceMediaId)) {
      throw new ShotUnavailableError(`The ${label} shot does not point at one of this product's photos.`);
    }
    const key = `${args.jobId}:${args.shot.sourceMediaId}`;
    const cropTarget = args.target?.box && !args.target.keep ? args.target : null;
    const inventoryTarget = args.target?.keep ? args.target : null;
    let pending = this.products.get(key);
    if (!pending) {
      pending = (async (): Promise<ProductLoad> => {
        let productRgba: RawImage;
        let costMicros = 0;
        if (cropTarget) {
          const source = loadMedia ? await loadMedia(args.shot.sourceMediaId) : null;
          if (!source || source.length === 0) {
            throw new ShotUnavailableError(`The source photo for the ${label} shot could not be loaded.`);
          }
          const upright = await prepareWorkingSource(source, WORKING_SOURCE_MAX_PX).catch(() => source);
          // Without an inventory, the cutout only sees the target plus a
          // margin (docs/phases/PHASE_13.md item 3). Cropping resamples
          // nothing and regenerates nothing (rule 3).
          const crop = await cropToTarget(upright, cropTarget.box as NormalizedBox);
          if (!crop) {
            throw new ShotUnavailableError(ISOLATION_FAILED);
          }
          // One pack never pays twice for the same photo: when the whole
          // photo was already cut out (the product inventory ran), the crop
          // is taken from that cutout instead of a second provider call.
          const reused = await this.cachedFullCutoutCrop(key, crop.source, crop.rect);
          let cutoutRgba: RawImage;
          if (reused) {
            cutoutRgba = reused;
          } else {
            let cutout: CallResult<CutoutOutput>;
            try {
              cutout = await callWithFailover<CutoutInput, CutoutOutput>(
                ai.registry,
                ai.routing,
                ai.meter,
                ai.breakerStore,
                {
                  task: CUTOUT_TASK,
                  input: { imageBytes: crop.bytes, format: "png" },
                  workspaceId: args.workspaceId,
                  jobId: args.jobId,
                  stepId: `${args.shot.id}:${CUTOUT_TASK}:${args.attempt}`,
                },
                { caps, ...routedCallHooks(ai) },
              );
            } catch (err) {
              const billed = failureSpendMicros(err);
              throw billed > 0 ? new ProductLoadError(err, billed) : err;
            }
            costMicros = cutout.costMicros + cutout.billedFailureMicros;
            cutoutRgba = await restoreSourceEdges(await decodeToRgba(Buffer.from(cutout.output.imageBytes)), crop.bytes);
          }
          // Keep only the cutout pieces on the target; every other product
          // the cutout kept becomes fully transparent. Kept pixels are byte
          // identical, so the fidelity check still proves rule 3.
          const isolated = isolateCutout(cutoutRgba, cropTarget, crop);
          if (isolated.refusal !== undefined) {
            console.warn(`[live] job ${args.jobId} photo ${args.shot.sourceMediaId} isolation refused: ${isolated.refusal}`);
            return { product: null, refusal: isolated.refusal, costMicros };
          }
          productRgba = isolated.image;
        } else {
          const load = await this.fullCutout(
            args.jobId,
            args.workspaceId,
            args.shot.sourceMediaId,
            caps,
            `${args.shot.id}:${CUTOUT_TASK}:${args.attempt}`,
            `${label} shot`,
          );
          productRgba = load.rgba;
          if (inventoryTarget) {
            // Keep exactly the pieces the inventory featured; every other
            // product becomes fully transparent. Kept pixels are byte
            // identical, so the fidelity check still proves rule 3.
            const isolated = isolateInventoryTarget(load.rgba, inventoryTarget);
            if (isolated.refusal !== undefined) {
              console.warn(`[live] job ${args.jobId} photo ${args.shot.sourceMediaId} isolation refused: ${isolated.refusal}`);
              return { product: null, refusal: isolated.refusal, costMicros };
            }
            productRgba = isolated.image;
          }
        }
        const mask = alphaMask(productRgba);
        const refusal = segmentationRefusal(mask);
        if (refusal) {
          console.warn(`[live] job ${args.jobId} photo ${args.shot.sourceMediaId} cutout refused: ${refusal}`);
          return { product: null, refusal, costMicros };
        }
        const product: LiveProduct = {
          productRgba,
          mask,
          productPng: await encodePng(productRgba),
          maskPng: await encodeMaskPng(mask),
        };
        return { product, costMicros };
      })();
      this.products.set(key, pending);
      pending.catch(() => this.products.delete(key));
    }
    let loaded: ProductLoad;
    try {
      loaded = await pending;
    } catch (err) {
      if (err instanceof ProductLoadError) {
        if (!err.claimed) {
          err.claimed = true;
          spend.micros += err.billedMicros;
        }
        throw err.original;
      }
      throw err;
    }
    if (!this.productCostClaimed.has(key)) {
      this.productCostClaimed.add(key);
      spend.micros += loaded.costMicros;
    }
    spend.micros += this.claimCutoutCost(key);
    if (!loaded.product) {
      throw new ShotUnavailableError(loaded.refusal ?? SEGMENTATION_FAILED);
    }
    return loaded.product;
  }

  /**
   * The brand logo's bytes, loaded once per workspace and key, or null when
   * the kit has none, the key sits outside the workspace, or it cannot be
   * read. A logo is optional styling, so a failed read never fails a shot.
   */
  private logoFor(args: ShotGenerateArgs): Promise<Buffer | null> {
    const key = args.brand?.logoKey;
    const { loadMedia } = this.opts;
    if (!key || !loadMedia || !isWorkspaceObjectKey(args.workspaceId, key)) {
      return Promise.resolve(null);
    }
    const cacheKey = `${args.workspaceId}:${key}`;
    let pending = this.logos.get(cacheKey);
    if (!pending) {
      pending = loadMedia(key).catch((err: unknown) => {
        console.warn(`[live] job ${args.jobId} brand logo could not be loaded`, err);
        return null;
      });
      this.logos.set(cacheKey, pending);
    }
    return pending;
  }

  /** Scene prompt and product fill for a composite, all from seed data. */
  private compositeTemplate(
    shot: ShotGenerateArgs["shot"],
    spec: ChannelSpec,
    repairHint: string | undefined,
  ): { scenePrompt: string; fill: number } {
    const presetKey: PresetKey = shot.stylePreset in presets ? (shot.stylePreset as PresetKey) : sceneDefaults.preset;
    const scene = shot.scene ?? templates.scene_fallback({ shotLabel: shot.type.replaceAll("_", " ") });
    const scenePrompt = templates.lifestyle_plate_flux2({ scene, preset: presetKey, repairHint });
    const fill = spec.fill ? (spec.fill.min + spec.fill.max) / 2 : canvasDefaults.compositeFill;
    return { scenePrompt, fill };
  }

  /**
   * Encodes a composite for its spec and sizes its rule 3 check region from
   * the paste erosion actually applied (thin products get a smaller one).
   * PNG first when the spec takes it and it fits, since it is lossless;
   * otherwise the JPEG ladder keeps only a quality whose decoded product
   * pixels still pass the fidelity check, and a spec where none passes sends
   * the shot to needs review. The returned image is decoded from the shipped
   * bytes (Update.md 2.3).
   */
  private async finishComposite(
    result: CompositeResult,
    spec: ChannelSpec,
    costMicros: number,
    spendReserved: boolean,
  ): Promise<ShotGeneration> {
    const erosion = await compositeQcErosion(result.canvasMask, result.effectivePasteErodePx);
    // A spec no encoding can meet throws ShotUnavailableError; generate()
    // books the paid scene on it from the attempt's spend.
    const out = await encodeForSpec(result.finalRaw, result.canvasMask, result.productReference, spec, {
      preferPng: true,
      erodePx: erosion.erodePx,
    });
    return {
      image: out.image,
      mask: result.canvasMask,
      productReference: result.productReference,
      encoded: out.encoded,
      costMicros,
      spendReserved,
      fidelityRequired: true,
      fidelityErodePx: erosion.erodePx,
      fidelityErodeFloorPx: erosion.floorPx,
      canvas: result.finalRaw,
    };
  }

  /**
   * The seller's kept photo for one spec (PHASE_15 item 17): the stored
   * upload fitted by live-original.ts. No cutout, no provider and no spend,
   * so it renders whatever the cutout wiring says.
   */
  private async generateOriginal(args: ShotGenerateArgs): Promise<ShotGeneration> {
    const { shot } = args;
    const specId = shot.channels[0];
    if (!specId) {
      throw new ShotUnavailableError("This shot has no channel to size it for, so it needs review.");
    }
    try {
      const rendered = await renderOriginalShot({
        shot,
        spec: getSpec(specId),
        output: args.output,
        workspaceId: args.workspaceId,
        loadSource: this.opts.loadMedia ? (key) => this.sourceFor(args.jobId, key) : null,
        ...(args.reencodedAtUpload ? { reencodedAtUpload: true } : {}),
      });
      if (rendered.kind === "unchanged") {
        return {
          // The stored bytes ship as they are; the runner proves them by
          // sha256 and never decodes them, so the image carries its size only.
          image: { data: Buffer.alloc(0), width: rendered.width, height: rendered.height, channels: 4 },
          mask: null,
          encoded: rendered.encoded,
          costMicros: 0,
          fidelityKind: "main",
          treatment: rendered.treatment,
          passthrough: { sha256: rendered.sha256 },
        };
      }
      const { still } = rendered;
      return {
        image: still.image,
        mask: still.mask,
        productReference: still.productReference,
        encoded: still.encoded,
        costMicros: 0,
        fidelityRequired: true,
        fidelityKind: still.fidelityKind,
        treatment: still.treatment,
        ...(still.fidelityErosion
          ? { fidelityErodePx: still.fidelityErosion.erodePx, fidelityErodeFloorPx: still.fidelityErosion.floorPx }
          : {}),
      };
    } catch (err) {
      if (err instanceof ShotUnavailableError) {
        throw err;
      }
      console.error(`[live] ${shot.id} kept photo render failed`, err);
      throw new ShotUnavailableError(ORIGINAL_NOT_PREPARED);
    }
  }

  /**
   * An already white kept photo's white required file (PHASE_15 control 7),
   * or null for the made white path. It needs the preflight cutout mask from
   * the upload's cache (never a new provider call just for detection), a
   * background that already passes the main class white check outside the
   * mask, and a crop plus white pad that reaches spec.fill. The file is the
   * photo itself cropped, resized and padded with white: no composite and no
   * cutout pixels, proven exact against its own reference before encoding,
   * and the main class checks run on it here so a file that would fail them
   * takes the made white path instead. The runner's checks gate it again.
   */
  private async alreadyWhite(args: ShotGenerateArgs): Promise<ShotGeneration | null> {
    const { shot, output } = args;
    const specId = shot.channels[0];
    if (
      !this.opts.cutoutCache ||
      !output?.keepMediaIds.includes(shot.sourceMediaId) ||
      !MADE_WHITE_TYPES.has(shot.type) ||
      !specId ||
      !isWorkspaceObjectKey(args.workspaceId, shot.sourceMediaId)
    ) {
      return null;
    }
    const spec = getSpec(specId);
    if (!requiresWhiteBackground(spec)) {
      return null;
    }
    try {
      const source = await this.sourceFor(args.jobId, shot.sourceMediaId);
      const cutout = source && source.length > 0 ? await this.cachedCutoutOf(args.workspaceId, source) : null;
      if (!source || !cutout) {
        return null;
      }
      const productMask = alphaMask(cutout);
      if (segmentationRefusal(productMask)) {
        return null;
      }
      const detection = await detectAlreadyWhite(source, productMask, spec, { edgeMarginPx: QC_EDGE_MARGIN_PX });
      if (!detection.alreadyWhite) {
        return null;
      }
      const file = await makeAlreadyWhite(source, productMask, spec, {
        maxUpscale: MAX_SOURCE_UPSCALE,
        edgeMarginPx: QC_EDGE_MARGIN_PX,
        ...(args.reencodedAtUpload ? { reencodedAtUpload: true } : {}),
      });
      if (!file.ok) {
        return null;
      }
      const canvas = { width: file.width, height: file.height };
      const reference = await buildProductReferenceFromEncoded(source, file.placement, canvas);
      const erosion = await stillQcErosion(file.mask, file.treatment.scale ?? 1);
      const exact = await fidelityReport(reference, file.raw, file.mask, {
        kind: "main",
        exact: true,
        erodePx: erosion.erodePx,
      });
      if (!exact.pass) {
        console.warn(`[live] job ${args.jobId} already white file for ${specId} drifted; using the made white path`);
        return null;
      }
      const out = await encodeForSpec(file.raw, file.mask, reference, spec, {
        preferPng: true,
        erodePx: erosion.erodePx,
        fidelityKind: "main",
      });
      const pixel = await pixelChecks(out.image, file.productMask, spec, {
        encoded: { bytes: out.encoded.buffer.length, format: out.encoded.format },
        edgeMarginPx: QC_EDGE_MARGIN_PX,
      });
      if (!pixel.pass) {
        return null;
      }
      return {
        image: out.image,
        mask: file.mask,
        qcMask: file.productMask,
        productReference: reference,
        encoded: out.encoded,
        costMicros: 0,
        fidelityRequired: true,
        fidelityKind: "main",
        fidelityErodePx: erosion.erodePx,
        fidelityErodeFloorPx: erosion.floorPx,
        treatment: { ...file.treatment, alreadyWhite: true },
      };
    } catch (err) {
      console.warn(`[live] job ${args.jobId} already white check failed; using the made white path`, err);
      return null;
    }
  }

  private async generateLive(args: ShotGenerateArgs, spend: AttemptSpend): Promise<ShotGeneration> {
    const { wiring, loadMedia } = this.opts;
    const { shot } = args;
    const label = shot.type.replaceAll("_", " ");
    const method = shot.method;
    const isComposite = COMPOSITE_METHODS.has(method);
    // The seller's kept photo needs no cutout and no product, so it runs
    // before the cutout wiring gate and productFor.
    if (shot.type === "original_photo" && method === "deterministic") {
      return this.generateOriginal(args);
    }
    if (!isComposite && method !== "deterministic" && method !== "template") {
      throw new ShotUnavailableError(`The ${label} shot is not produced by live providers yet.`);
    }
    if (method === "deterministic" && !DETERMINISTIC_LIVE_TYPES.has(shot.type)) {
      throw new ShotUnavailableError(`The ${label} shot is not produced by live providers yet.`);
    }
    if (method === "template" && !TEMPLATE_STILL_TYPES.has(shot.type)) {
      throw new ShotUnavailableError(`The ${label} shot needs seller details this pack does not have.`);
    }
    // An already white kept photo makes its own white file from the cached
    // preflight mask, with no provider; otherwise the made white path below.
    const own = method === "deterministic" ? await this.alreadyWhite(args) : null;
    if (own) {
      return own;
    }
    if (!wiring.cutoutLive || !loadMedia || (isComposite && wiring.imageProviders.length === 0)) {
      throw new ShotUnavailableError(
        `The ${label} shot needs the ${isComposite ? "image, cutout" : "cutout"} and storage providers, and at least one is not configured.`,
      );
    }

    // Refusals that need no cutout happen before any money is spent.
    if (!isComposite) {
      precheckStill(shot, label);
    } else if (await this.sceneChainOpen()) {
      // Every image provider sits behind an open breaker (failing or out of
      // quota): the scene is paused without trying, and the pack delivers
      // its other files (docs/phases/PHASE_14.md 1.3).
      throw new ShotUnavailableError(SHOT_SCENE_PAUSED);
    }

    const caps = this.capsFor(args);
    const product = await this.productFor(args, caps, spend);
    const spendReserved = caps !== undefined;

    if (method === "deterministic" || method === "template") {
      try {
        const still: StillRender =
          method === "deterministic"
            ? await renderDeterministicShot({
                shot,
                product,
                brandColors: args.brandColors,
                output: args.output,
                keptSource: args.output?.keepMediaIds.includes(shot.sourceMediaId) === true,
              })
            : await renderTemplateStill({
                type: shot.type as TemplateStillType,
                spec: getSpec(shot.channels[0]),
                productPng: product.productPng,
                maskPng: product.maskPng,
                callouts: shot.callouts,
                backgroundHex:
                  (stillStyle.presetBackgroundHex as Record<string, string>)[shot.stylePreset] ??
                  stillStyle.defaultBackgroundHex,
                textHex: stillStyle.textHex,
                accentHex: stillStyle.accentHex,
                fonts: args.brand?.fonts,
                logo: await this.logoFor(args),
              });
        const erosion = still.fidelityErosion ?? (await stillErosionFromMasks(product.mask, still.mask));
        return {
          image: still.image,
          mask: still.mask,
          productReference: still.productReference,
          encoded: still.encoded,
          costMicros: spend.micros,
          spendReserved,
          fidelityRequired: true,
          ...(erosion ? { fidelityErodePx: erosion.erodePx, fidelityErodeFloorPx: erosion.floorPx } : {}),
          ...(still.treatment ? { treatment: still.treatment } : {}),
        };
      } catch (err) {
        // A still that cannot be rendered ends this shot only, never the
        // pack, and keeps the cutout cost it already spent on the books.
        throw stillFailure(err, label, spend.micros, args);
      }
    }

    const { productRgba, mask } = product;
    const { ai } = this.opts;
    const spec = getSpec(args.shot.channels[0]);
    const { width, height } = canvasSizeFor(spec);
    const { scenePrompt, fill } = this.compositeTemplate(args.shot, spec, args.repairHint);

    // Plan 5.6: after three failed attempts the extra attempt switches to
    // the fallback provider, expressed here by rotating the failover chain.
    const chain =
      args.useFallbackProvider && wiring.imageProviders.length > 1
        ? [...wiring.imageProviders.slice(1), wiring.imageProviders[0]]
        : wiring.imageProviders;
    const sceneRouting: RoutingTable = { [SCENE_PLATE_TASK]: chain, [HARMONIZE_TASK]: chain };
    // Every scene call's spend, billed failures included, lands on this
    // attempt, so a shot that fails after a paid plate still books it.
    const routedScene: Provider = {
      name: "scene-plate-chain",
      kind: "image",
      supports: (task) => task === SCENE_PLATE_TASK || task === HARMONIZE_TASK,
      invoke: async <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
        try {
          const result = await callWithFailover<TIn, TOut>(ai.registry, sceneRouting, ai.meter, ai.breakerStore, req, {
            caps,
            ...routedCallHooks(ai),
          });
          const costMicros = result.costMicros + result.billedFailureMicros;
          spend.micros += costMicros;
          return { output: result.output, costMicros };
        } catch (err) {
          spend.micros += failureSpendMicros(err);
          throw err;
        }
      },
    };

    const result = await compositeShot({
      productRgba,
      mask,
      provider: routedScene,
      shot: args.shot,
      template: {
        width,
        height,
        scenePrompt,
        harmonizePrompt: templates.harmonize_nano_banana2(),
        placement: { fill },
      },
      workspaceId: args.workspaceId,
      jobId: args.jobId,
    });

    return this.finishComposite(result, spec, spend.micros, spendReserved);
  }
}

/**
 * Maps whatever ended a live attempt to what the runner needs, always with
 * the attempt's provider spend so it stays on the shot's books: a refusal,
 * a spend cap block, a content block or a harmonize output in the wrong
 * shape becomes ShotUnavailableError (that one shot goes to review, never
 * the pack); anything else after spend is wrapped in
 * ShotFailedAfterSpendError, and a failure before any spend passes through.
 */
function attemptFailure(err: unknown, spend: AttemptSpend): unknown {
  if (err instanceof ShotUnavailableError) {
    return new ShotUnavailableError(err.message, spend.micros);
  }
  if (isSpendCapBlock(err)) {
    return new ShotUnavailableError(SPEND_CAP_REACHED, spend.micros);
  }
  if (hasProviderErrorCode(err, "content_blocked")) {
    return new ShotUnavailableError(SHOT_CONTENT_BLOCKED, spend.micros);
  }
  if (providerErrorsOf(err).some((e) => e instanceof HarmonizeAspectError)) {
    return new ShotUnavailableError(HARMONIZE_SHAPE_REFUSED, spend.micros);
  }
  return spend.micros > 0 ? new ShotFailedAfterSpendError(err, spend.micros) : err;
}
