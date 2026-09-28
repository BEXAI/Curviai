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
  BflFluxProvider,
  callWithFailover,
  type CapsHook,
  GeminiImageProvider,
  OpenaiImageProvider,
  PhotoroomCutoutProvider,
  ProviderError,
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
  encodeJpeg,
  type ImageOutput,
  type HarmonizeInput,
  type RawImage,
  type RawMask,
  type ScenePlateInput,
} from "@curvi/pipeline";
import {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  imageModelSeedRows,
  llmModelPrices,
  photoroomSeed,
  presets,
  recipeSeedRows,
  templates,
  type ImageModelSeedRow,
  type PresetKey,
} from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import {
  isSpendCapBlock,
  ShotUnavailableError,
  type PipelineDeps,
  type ShotGenerateArgs,
  type ShotGeneration,
  type ShotGenerator,
} from "./pipeline-runner";

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
export class ScenePlateBridge implements Provider {
  readonly name: string;
  readonly kind: ProviderKind = "image";

  constructor(
    private readonly inner: CostAwareProvider,
    private readonly family: ImageModelSeedRow["family"],
    name: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.name = name;
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
      const res = await this.inner.invoke<GeminiImageInput, GeminiImageOutput>({
        ...req,
        input: { prompt: input.prompt },
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
      const buffer = await this.download(res.output.imageUrl, req.task);
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
      const buffer = await this.download(image.url, req.task);
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
      const res = await this.inner.invoke<GeminiImageInput, GeminiImageOutput>({
        ...req,
        input: {
          prompt: input.prompt,
          images: [{ mimeType: "image/png", dataBase64: input.png.toString("base64") }],
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
      const buffer = await this.download(res.output.imageUrl, req.task);
      return { buffer, costMicros: res.costMicros };
    }
    return { buffer: input.png, costMicros: 0 };
  }

  private async download(url: string, task: string): Promise<Buffer> {
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new ProviderError(`Image download failed with status ${res.status}`, this.name, task, true);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

function clampToStep(value: number, step: number, min: number, max: number): number {
  const clamped = Math.min(Math.max(value, min), max);
  return Math.max(min, Math.floor(clamped / step) * step);
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
    for (const recipe of recipeSeedRows) {
      if (!recipe.active) continue;
      const priceTable = llmModelPrices[recipe.model];
      if (!priceTable) continue;
      const name = `anthropic-${recipe.key}`;
      registry.register(
        new AnthropicLLMProvider({
          name,
          tasks: [recipe.key],
          apiKey: anthropicKey,
          model: recipe.model,
          priceTable,
        }),
      );
      routing[recipe.key] = [name];
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
    registry.register(new ScenePlateBridge(inner, row.family, row.providerName, fetchFn));
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

/** Mask from the alpha channel of an RGBA cutout. */
export function alphaMask(image: RawImage): RawMask {
  const data = Buffer.alloc(image.width * image.height, 0);
  for (let i = 0; i < image.width * image.height; i++) {
    data[i] = image.data[i * 4 + 3] > 8 ? 255 : 0;
  }
  return { data, width: image.width, height: image.height };
}

const LIVE_METHODS: ReadonlySet<string> = new Set(["composite_generate", "edit_generate"]);

export interface LiveShotGeneratorOptions {
  ai: PipelineDeps["ai"];
  wiring: LiveWiring;
  /** Null when R2 is not configured; every shot is then unavailable. */
  loadMedia: MediaLoader | null;
}

/**
 * Real shot generator for composite and edit methods: load the source photo
 * from R2, cut the product out with Photoroom, generate the scene plate
 * through the image chain, and paste the original product pixels back via
 * compositeShot so the fidelity lock holds.
 *
 * Anything it cannot produce for real (deterministic, template and video
 * methods until their live paths land, a missing or foreign source photo, a
 * spend cap block) throws ShotUnavailableError: the shot goes to needs
 * review with its credits released. It never substitutes demo output, which
 * would ship a placeholder as the customer's product and charge for it.
 *
 * Every provider call reserves its estimated cost against the per asset,
 * pack and global day caps before it runs (plan 4.4), so the hard stop
 * actually stops spend instead of noticing it afterwards.
 */
export class LiveShotGenerator implements ShotGenerator {
  constructor(private readonly opts: LiveShotGeneratorOptions) {}

  async generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    try {
      return await this.generateLive(args);
    } catch (err) {
      if (isSpendCapBlock(err)) {
        throw new ShotUnavailableError("Spend cap reached before this shot could be generated.");
      }
      throw err;
    }
  }

  private async generateLive(args: ShotGenerateArgs): Promise<ShotGeneration> {
    const { ai, wiring, loadMedia } = this.opts;
    const label = args.shot.type.replaceAll("_", " ");
    if (!LIVE_METHODS.has(args.shot.method)) {
      throw new ShotUnavailableError(`The ${label} shot is not produced by live providers yet.`);
    }
    if (wiring.imageProviders.length === 0 || !wiring.cutoutLive || !loadMedia) {
      throw new ShotUnavailableError(
        `The ${label} shot needs the image, cutout and storage providers, and at least one is not configured.`,
      );
    }
    // Source photos live under the workspace's own prefix; anything else
    // (a planner hallucination or another tenant's key) is never loaded.
    if (!args.shot.sourceMediaId.startsWith(`ws/${args.workspaceId}/`)) {
      throw new ShotUnavailableError(`The ${label} shot does not point at one of this product's photos.`);
    }
    const source = await loadMedia(args.shot.sourceMediaId);
    if (!source || source.length === 0) {
      throw new ShotUnavailableError(`The source photo for the ${label} shot could not be loaded.`);
    }

    const caps: CapsHook[] | undefined = ai.caps
      ? [
          { spendCaps: ai.caps, capKind: "image_asset", assetId: args.shot.id },
          { spendCaps: ai.caps, capKind: "pack", jobId: args.jobId },
          { spendCaps: ai.caps, capKind: "global_day" },
        ]
      : undefined;

    const cutout = await callWithFailover<PhotoroomCutoutInput, PhotoroomCutoutOutput>(
      ai.registry,
      ai.routing,
      ai.meter,
      ai.breakerStore,
      {
        task: CUTOUT_TASK,
        input: { imageBytes: source, format: "png" },
        workspaceId: args.workspaceId,
        jobId: args.jobId,
        stepId: `${args.shot.id}:${CUTOUT_TASK}:${args.attempt}`,
      },
      { caps },
    );
    const productRgba = await decodeToRgba(Buffer.from(cutout.output.imageBytes));
    const mask = alphaMask(productRgba);

    const specId = args.shot.channels[0];
    const spec = getSpec(specId);
    const width = spec.width ?? spec.minWidth ?? 1200;
    const height = spec.height ?? spec.minHeight ?? width;
    const fill = spec.fill ? (spec.fill.min + spec.fill.max) / 2 : 0.55;

    const presetKey: PresetKey =
      args.shot.stylePreset in presets ? (args.shot.stylePreset as PresetKey) : "minimal_studio";
    const scene = args.shot.scene ?? `${args.shot.type.replaceAll("_", " ")} setting`;
    let scenePrompt = templates.lifestyle_plate_flux2({ scene, preset: presetKey });
    if (args.repairHint) {
      scenePrompt = `${scenePrompt} Repair instruction from the previous attempt: ${args.repairHint}`;
    }

    // Plan 5.6: after three failed attempts the extra attempt switches to
    // the fallback provider, expressed here by rotating the failover chain.
    const chain =
      args.useFallbackProvider && wiring.imageProviders.length > 1
        ? [...wiring.imageProviders.slice(1), wiring.imageProviders[0]]
        : wiring.imageProviders;
    const sceneRouting: RoutingTable = { [SCENE_PLATE_TASK]: chain, [HARMONIZE_TASK]: chain };
    const routedScene: Provider = {
      name: "scene-plate-chain",
      kind: "image",
      supports: (task) => task === SCENE_PLATE_TASK || task === HARMONIZE_TASK,
      invoke: async <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
        const result = await callWithFailover<TIn, TOut>(ai.registry, sceneRouting, ai.meter, ai.breakerStore, req, {
          caps,
        });
        return { output: result.output, costMicros: result.costMicros };
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

    const formats = (spec.formats ?? ["png"]) as readonly string[];
    const usePng = formats.includes("png") || !formats.includes("jpg");
    const encoded = usePng
      ? { buffer: result.png, format: "png" }
      : { buffer: await encodeJpeg(result.finalRaw), format: "jpg" };

    return {
      image: result.finalRaw,
      mask: result.canvasMask,
      productReference: result.productReference,
      encoded,
      costMicros: cutout.costMicros + result.costMicros,
      spendReserved: caps !== undefined,
    };
  }
}
