/**
 * The fal BiRefNet cutout (Phase 14, the default cutout provider) feeds the
 * same cutout path as before: a transparent PNG through alphaMask, the
 * segmentation refusal checks and isolateComponents, with product pixels
 * byte identical (rule 3). Also: the quota event notifier, and one pack
 * never paying twice for the same photo's cutout. No real API is called.
 */

import { describe, expect, it } from "vitest";
import {
  callWithFailover,
  FalCutoutProvider,
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderRegistry,
  type CutoutInput,
  type CutoutOutput,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { boxToPixels, decodeToRgba, encodePng, isolateComponents, solidCanvas, type RawImage } from "@curvi/pipeline";
import { CUTOUT_TASK, cutoutModelSeedRows } from "@curvi/pipeline/seed";
import {
  alphaMask,
  isolateInventoryTarget,
  LiveShotGenerator,
  segmentationRefusal,
} from "./live-runtime";
import { PROVIDER_QUOTA_EVENT, PROVIDER_QUOTA_EVENT_WINDOW_MS, ProviderQuotaNotifier } from "./provider-quota";
import type { ProductTarget } from "./pipeline-runner";

const W = 120;
const H = 80;
const LEFT = { x: 0.1, y: 0.25, width: 0.25, height: 0.5 };
const RIGHT = { x: 0.6, y: 0.25, width: 0.25, height: 0.5 };

/** A two product transparent cutout PNG, textured so byte identity means something. */
async function twoProductCutout(): Promise<Buffer> {
  const image = solidCanvas(W, H, 0, 0, 0, 0);
  for (const [box, seedStart] of [
    [LEFT, 11],
    [RIGHT, 29],
  ] as const) {
    const rect = boxToPixels(box, W, H);
    let seed = seedStart;
    for (let y = rect.top; y < rect.top + rect.height; y++) {
      for (let x = rect.left; x < rect.left + rect.width; x++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const i = (y * W + x) * 4;
        image.data[i] = seed % 256;
        image.data[i + 1] = (seed >> 8) % 256;
        image.data[i + 2] = (seed >> 16) % 256;
        image.data[i + 3] = 255;
      }
    }
  }
  return encodePng(image);
}

/** A fal queue stub that completes at once and serves `png` as the cutout. */
function falFetch(png: Buffer): { fetchFn: typeof fetch; submits: number } {
  const state = { submits: 0 };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.endsWith("/requests/r1")) {
      return Response.json({ image: { url: "https://v3.fal.media/files/cutout.png", content_type: "image/png" } });
    }
    if (url.startsWith("https://v3.fal.media/")) return new Response(new Uint8Array(png));
    state.submits += 1;
    return Response.json({
      request_id: "r1",
      status_url: "https://queue.fal.run/fal-ai/birefnet/requests/r1/status",
      response_url: "https://queue.fal.run/fal-ai/birefnet/requests/r1",
    });
  }) as typeof fetch;
  return {
    fetchFn,
    get submits() {
      return state.submits;
    },
  };
}

function falProvider(fetchFn: typeof fetch): FalCutoutProvider {
  const row = cutoutModelSeedRows[0];
  return new FalCutoutProvider({
    name: row.providerName,
    tasks: [CUTOUT_TASK],
    apiKey: "fal-test-key",
    modelId: row.model,
    modelParams: row.params,
    priceTable: { perCallMicros: row.perCallMicros },
    fetchFn,
    pollIntervalMs: 0,
  });
}

function sameRgba(a: RawImage, b: RawImage): boolean {
  return a.width === b.width && a.height === b.height && a.data.equals(b.data);
}

describe("fal cutout through the existing cutout path", () => {
  it("flows through the router, alphaMask, the refusal checks and isolateComponents exactly like a direct cutout", async () => {
    const png = await twoProductCutout();
    const fal = falFetch(png);
    const registry = new ProviderRegistry();
    registry.register(falProvider(fal.fetchFn));
    const result = await callWithFailover<CutoutInput, CutoutOutput>(
      registry,
      { [CUTOUT_TASK]: [cutoutModelSeedRows[0].providerName] },
      new InMemoryCostMeter(),
      new InMemoryBreakerStore(),
      { task: CUTOUT_TASK, input: { imageBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), format: "png" } },
    );
    expect(result.costMicros).toBe(cutoutModelSeedRows[0].perCallMicros);

    const viaFal = await decodeToRgba(Buffer.from(result.output.imageBytes));
    const direct = await decodeToRgba(png);
    expect(sameRgba(viaFal, direct)).toBe(true);

    // Mask and refusal checks see a usable, two piece cutout.
    const mask = alphaMask(viaFal);
    expect(segmentationRefusal(mask)).toBeNull();
    expect([...mask.data].filter((v) => v === 255).length).toBe([...alphaMask(direct).data].filter((v) => v === 255).length);

    // The inventory keeps exactly the featured piece, byte identical.
    const target: ProductTarget = { label: "watch", box: LEFT, keep: [LEFT], others: [{ label: "sneaker", box: RIGHT }] };
    const isolated = isolateInventoryTarget(viaFal, target);
    expect(isolated.refusal).toBeUndefined();
    const kept = isolated.image!;
    const left = boxToPixels(LEFT, W, H);
    const right = boxToPixels(RIGHT, W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const inLeft = x >= left.left && x < left.left + left.width && y >= left.top && y < left.top + left.height;
        const inRight = x >= right.left && x < right.left + right.width && y >= right.top && y < right.top + right.height;
        if (inLeft) expect(kept.data.subarray(i, i + 4).equals(direct.data.subarray(i, i + 4))).toBe(true);
        if (inRight) expect(kept.data[i + 3]).toBe(0);
      }
    }
    // Same answer as isolateComponents on the direct cutout.
    const reference = isolateComponents(direct, [left], [right]);
    expect(sameRgba(kept, reference.image)).toBe(true);
  });

  it("refuses a fal cutout that kept the whole background, like any other", async () => {
    const full = await encodePng(solidCanvas(40, 40, 10, 20, 30, 255));
    const fal = falFetch(full);
    const res = await falProvider(fal.fetchFn).invoke<CutoutInput, CutoutOutput>({
      task: CUTOUT_TASK,
      input: { imageBytes: new Uint8Array(full) },
    });
    const mask = alphaMask(await decodeToRgba(Buffer.from(res.output.imageBytes)));
    expect(segmentationRefusal(mask)).not.toBeNull();
  });
});

describe("ProviderQuotaNotifier", () => {
  it("writes one events row per provider per hour, and tries again after a failed write", async () => {
    let now = 1_000;
    const rows: unknown[] = [];
    let failNext = false;
    const db = {
      insert: () => ({
        values: async (row: unknown) => {
          if (failNext) {
            failNext = false;
            throw new Error("db down");
          }
          rows.push(row);
        },
      }),
    };
    const log = { warn: () => {}, error: () => {} };
    const notifier = new ProviderQuotaNotifier({ db: db as never, now: () => now, log });
    expect(await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "402" })).toBe(true);
    expect(await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "402" })).toBe(false);
    expect(await notifier.notify({ provider: "gemini-image", task: "scene_plate", message: "429" })).toBe(true);
    expect(rows).toEqual([
      { workspaceId: null, name: PROVIDER_QUOTA_EVENT, props: { provider: "fal-birefnet", task: "cutout" } },
      { workspaceId: null, name: PROVIDER_QUOTA_EVENT, props: { provider: "gemini-image", task: "scene_plate" } },
    ]);
    now += PROVIDER_QUOTA_EVENT_WINDOW_MS;
    failNext = true;
    expect(await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "402" })).toBe(false);
    expect(await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "402" })).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("only logs without a database", async () => {
    const warnings: string[] = [];
    const notifier = new ProviderQuotaNotifier({ log: { warn: (line: string) => warnings.push(line), error: () => {} } });
    expect(await notifier.notify({ provider: "p", task: "t", message: "m" })).toBe(false);
    expect(JSON.parse(warnings[0])).toMatchObject({ event: PROVIDER_QUOTA_EVENT, provider: "p", task: "t", recorded: false });
  });
});

class CountingCutout implements Provider {
  readonly name = cutoutModelSeedRows[0].providerName;
  readonly kind = "cutout" as const;
  calls = 0;
  constructor(private readonly png: Buffer) {}
  supports(task: string): boolean {
    return task === CUTOUT_TASK;
  }
  estimateCostMicros(): number {
    return 10_000;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    return { output: { imageBytes: this.png, contentType: "image/png" } as TOut, costMicros: 10_000 };
  }
}

describe("one cutout per photo per pack", () => {
  it("crops a boxed target from the inventory's whole photo cutout instead of paying again", async () => {
    const cutoutBytes = await twoProductCutout();
    // The source photo has the cutout's size, so the crop lines up.
    const photo = await encodePng(solidCanvas(W, H, 200, 200, 200, 255));
    const cutout = new CountingCutout(cutoutBytes);
    const registry = new ProviderRegistry();
    registry.register(cutout);
    const generator = new LiveShotGenerator({
      ai: {
        registry,
        routing: { [CUTOUT_TASK]: [cutout.name] },
        meter: new InMemoryCostMeter(),
        breakerStore: new InMemoryBreakerStore(),
      },
      wiring: { llmLive: false, imageProviders: [], cutoutProviders: [cutout.name], cutoutLive: true },
      loadMedia: async () => photo,
    });
    const mediaId = "ws/ws1/src/photo";
    const inventory = await generator.inventoryCutout({ jobId: "job1", workspaceId: "ws1", mediaId });
    expect(inventory.cutout).not.toBeNull();
    expect(inventory.costMicros).toBe(10_000);
    expect(cutout.calls).toBe(1);

    const generation = await generator.generate({
      shot: {
        id: "s1",
        type: "amazon_main",
        method: "deterministic",
        sourceMediaId: mediaId,
        channels: ["amazon.main"],
        stylePreset: "clean_studio",
        credits: 1,
      } as never,
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job1",
      workspaceId: "ws1",
      target: { label: "watch", box: LEFT, others: [{ label: "sneaker", box: RIGHT }] },
    });
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
    // No second cutout call, and the inventory already booked its cost.
    expect(cutout.calls).toBe(1);
    expect(generation.costMicros).toBe(0);
  });
});
