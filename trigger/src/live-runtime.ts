/**
 * Live provider wiring. Reads provider API keys from env and upgrades the
 * demo registry and routing in place: Anthropic models per recipe task
 * (models and prices from the pipeline seed), the image scene plate chain
 * (Nano Banana 2, FLUX.2 pro, GPT Image 2 in failover order), Photoroom
 * cutouts, and a LiveShotGenerator that runs the fidelity lock composite
 * flow against real providers. With no keys set nothing here activates and
 * the demo implementations keep working.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AnthropicLLMProvider,
  ASYNC_JOB_TIMEOUT_MARGIN_MS,
  BflFluxProvider,
  callWithFailover,
  downloadBytes,
  type CallResult,
  type CapsHook,
  GeminiImageProvider,
  hasProviderErrorCode,
  OpenaiImageProvider,
  PhotoroomCutoutProvider,
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
  type PhotoroomCutoutInput,
  type PhotoroomCutoutOutput,
  type Provider,
  type ProviderKind,
  type ProviderRegistry,
  type ProviderRequest,
  type ProviderResponse,
  type RoutingTable,
} from "@curvi/ai";
import {
  compositeShot,
  decodeToRgba,
  deriveQcErodePx,
  encodePng,
  HarmonizeAspectError,
  normalizeOrientation,
  rawToSharp,
  renderTemplateStill,
  TEMPLATE_STILL_TYPES,
  TemplateUnavailableError,
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
  photoroomSeed,
  presets,
  recipeSeedRows,
  sceneDefaults,
  stillStyle,
  templates,
  type ImageModelSeedRow,
  type PresetKey,
} from "@curvi/pipeline/seed";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { ShotFailedAfterSpendError, ShotUnavailableError } from "./errors";
import { DETERMINISTIC_LIVE_TYPES, renderDeterministicShot } from "./live-deterministic";
import type { LiveProduct, StillRender } from "./live-product";
import { isWorkspaceObjectKey } from "./object-keys";
import { llmModelProviderName, seedRecipe } from "./recipes";
import {
  failureSpendMicros,
  isSpendCapBlock,
  routedCallHooks,
  SHOT_CONTENT_BLOCKED,
  type PipelineDeps,
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
  const wiring: LiveWiring = { llmLive: false, imageProviders: [], cutoutLive: false };

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

  const photoroomKey = readEnv("PHOTOROOM_API_KEY");
  if (photoroomKey) {
    registry.register(
      new PhotoroomCutoutProvider({
        name: photoroomSeed.providerName,
        tasks: [CUTOUT_TASK],
        apiKey: photoroomKey,
        priceTable: { perCallMicros: photoroomSeed.perCallMicros },
      }),
    );
    routing[CUTOUT_TASK] = [photoroomSeed.providerName];
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
  const needsText = shot.type === "infographic" || shot.type === "dimensions";
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

const COMPOSITE_METHODS: ReadonlySet<string> = new Set(["composite_generate", "edit_generate"]);

export interface LiveShotGeneratorOptions {
  ai: PipelineDeps["ai"];
  wiring: LiveWiring;
  /** Null when R2 is not configured; every shot is then unavailable. */
  loadMedia: MediaLoader | null;
}

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
 * it from R2, cut the product out with Photoroom (once per job and photo,
 * shared by every shot and attempt that uses it), then
 * - composite and edit methods generate a scene plate through the image
 *   chain and paste the original product pixels back via compositeShot;
 * - deterministic methods (white main image, alt angles, cutout, sweeps,
 *   collection thumb) place the real pixels with the whiten helpers;
 * - template methods (infographic, dimensions, A+ banner, social crops)
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
   * The cut out product for this shot's source photo. The Photoroom call runs
   * once per job and photo; the first shot to use it books its cost into its
   * spend, every later shot and retry reuses it for free. A failed load is
   * not cached, so the next attempt tries again (its billed spend is booked
   * once); an unusable cutout is cached as a refusal, so the photo is never
   * cut out twice only to be refused again.
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
    let pending = this.products.get(key);
    if (!pending) {
      pending = (async (): Promise<ProductLoad> => {
        const source = loadMedia ? await loadMedia(args.shot.sourceMediaId) : null;
        if (!source || source.length === 0) {
          throw new ShotUnavailableError(`The source photo for the ${label} shot could not be loaded.`);
        }
        // Phone photos often carry their rotation only as an EXIF tag, which
        // the cutout service ignores: send the pixels upright (Update.md
        // 7.8). Bytes sharp cannot read go as they are; the service may.
        const upright = await normalizeOrientation(source).catch(() => source);
        let cutout: CallResult<PhotoroomCutoutOutput>;
        try {
          cutout = await callWithFailover<PhotoroomCutoutInput, PhotoroomCutoutOutput>(
            ai.registry,
            ai.routing,
            ai.meter,
            ai.breakerStore,
            {
              task: CUTOUT_TASK,
              input: { imageBytes: upright, format: "png" },
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
        const costMicros = cutout.costMicros + cutout.billedFailureMicros;
        const productRgba = await decodeToRgba(Buffer.from(cutout.output.imageBytes));
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
    if (!loaded.product) {
      throw new ShotUnavailableError(loaded.refusal ?? SEGMENTATION_FAILED);
    }
    return loaded.product;
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

  private async generateLive(args: ShotGenerateArgs, spend: AttemptSpend): Promise<ShotGeneration> {
    const { wiring, loadMedia } = this.opts;
    const { shot } = args;
    const label = shot.type.replaceAll("_", " ");
    const method = shot.method;
    const isComposite = COMPOSITE_METHODS.has(method);
    if (!isComposite && method !== "deterministic" && method !== "template") {
      throw new ShotUnavailableError(`The ${label} shot is not produced by live providers yet.`);
    }
    if (method === "deterministic" && !DETERMINISTIC_LIVE_TYPES.has(shot.type)) {
      throw new ShotUnavailableError(`The ${label} shot is not produced by live providers yet.`);
    }
    if (method === "template" && !TEMPLATE_STILL_TYPES.has(shot.type)) {
      throw new ShotUnavailableError(`The ${label} shot needs seller details this pack does not have.`);
    }
    if (!wiring.cutoutLive || !loadMedia || (isComposite && wiring.imageProviders.length === 0)) {
      throw new ShotUnavailableError(
        `The ${label} shot needs the ${isComposite ? "image, cutout" : "cutout"} and storage providers, and at least one is not configured.`,
      );
    }

    // Refusals that need no cutout happen before any money is spent.
    if (!isComposite) {
      precheckStill(shot, label);
    }

    const caps = this.capsFor(args);
    const product = await this.productFor(args, caps, spend);
    const spendReserved = caps !== undefined;

    if (method === "deterministic" || method === "template") {
      try {
        const still: StillRender =
          method === "deterministic"
            ? await renderDeterministicShot({ shot, product, brandColors: args.brandColors })
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
