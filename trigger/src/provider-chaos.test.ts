/**
 * Chaos tests for Phase 14 workstream 1 (docs/phases/PHASE_14.md 1.2 to 1.4):
 * whole packs run on the live generator and the real router, with fake
 * providers that fail the way real ones do. Nothing calls a real API.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  FalCutoutProvider,
  httpProviderError,
  InMemoryBreakerStore,
  ProviderError,
  ProviderTimeoutError,
  type Provider,
  type ProviderQuotaInfo,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { encodePng, solidCanvas } from "@curvi/pipeline";
import { CUTOUT_TASK, HARMONIZE_TASK, SCENE_PLATE_TASK, cutoutModelSeedRows } from "@curvi/pipeline/seed";
import { LiveShotGenerator, wireLiveProviders } from "./live-runtime";
import { buildRuntimeDeps, demoRoutingTable } from "./runtime";
import { ProviderRegistry } from "@curvi/ai";
import {
  DEFAULT_DELAYED_RETRY_MS,
  runGeneratePack,
  SHOT_PROVIDER_TROUBLE,
  SHOT_SCENE_PAUSED,
  type GeneratePackInput,
  type PipelineDeps,
} from "./pipeline-runner";

const IMAGE_PROVIDERS = ["gemini-image", "bfl-flux", "openai-image"];
const CUTOUT = cutoutModelSeedRows[0].providerName;

/** RGBA cutout: transparent canvas with an opaque centered square. */
async function cutoutPng(size = 160): Promise<Buffer> {
  const image = solidCanvas(size, size, 120, 90, 60);
  for (let i = 0; i < size * size; i++) image.data[i * 4 + 3] = 0;
  const start = Math.floor(size * 0.25);
  const end = Math.floor(size * 0.75);
  for (let y = start; y < end; y++) {
    for (let x = start; x < end; x++) image.data[(y * size + x) * 4 + 3] = 255;
  }
  return encodePng(image);
}

type Failure = () => Error;

/** An image provider that fails every call with the given error. */
class FailingImageProvider implements Provider {
  readonly kind = "image" as const;
  calls = 0;
  constructor(
    readonly name: string,
    private readonly fail: Failure,
  ) {}
  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === HARMONIZE_TASK;
  }
  estimateCostMicros(): number {
    return 60_000;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    throw this.fail();
  }
}

class GoodCutout implements Provider {
  readonly kind = "cutout" as const;
  calls = 0;
  constructor(
    private readonly png: Buffer,
    readonly name: string = CUTOUT,
  ) {}
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

const packInput: GeneratePackInput = {
  jobId: "job-chaos",
  workspaceId: "ws1",
  tier: "starter",
  channels: ["amazon"],
  creditBudget: 40,
  images: [{ mediaId: "ws/ws1/src/photo" }],
  sku: "WATCH1",
  seoSlug: "silver-watch",
};

interface ChaosRun {
  deps: PipelineDeps;
  sleeps: number[];
  quota: ProviderQuotaInfo[];
  breakerStore: InMemoryBreakerStore;
}

/** A live pack whose image providers all fail with `fail`, and whose cutout
 * is `cutout` (a working fake by default). */
async function chaosDeps(fail: Failure | null, cutout?: Provider): Promise<ChaosRun> {
  const deps = buildRuntimeDeps();
  const breakerStore = new InMemoryBreakerStore();
  const quota: ProviderQuotaInfo[] = [];
  deps.ai.breakerStore = breakerStore;
  deps.ai.onProviderQuota = (info) => {
    quota.push(info);
  };
  deps.ai.onInternalError = () => {};
  if (fail) {
    for (const name of IMAGE_PROVIDERS) deps.ai.registry.register(new FailingImageProvider(name, fail));
  }
  deps.ai.registry.register(cutout ?? new GoodCutout(await cutoutPng()));
  deps.ai.routing[SCENE_PLATE_TASK] = [...IMAGE_PROVIDERS];
  deps.ai.routing[HARMONIZE_TASK] = [...IMAGE_PROVIDERS];
  deps.ai.routing[CUTOUT_TASK] = [CUTOUT];
  const sleeps: number[] = [];
  const generator = new LiveShotGenerator({
    ai: deps.ai,
    wiring: { llmLive: false, imageProviders: fail ? [...IMAGE_PROVIDERS] : [], cutoutProviders: [CUTOUT], cutoutLive: true },
    loadMedia: async () => Buffer.from("source-photo"),
  });
  return {
    deps: {
      ...deps,
      generator,
      excludeShotMethods: ["video_generate", "avatar"],
      delayedRetry: {
        delayMs: DEFAULT_DELAYED_RETRY_MS,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    },
    sleeps,
    quota,
    breakerStore,
  };
}

type AssetRow = { shotId: string; shotType: string; status: string; credits: number; verdict: { repairHint: string } };

function assetsOf(deps: PipelineDeps): AssetRow[] {
  return (deps.store as unknown as { assets: AssetRow[] }).assets;
}

function ledgerOf(deps: PipelineDeps): Array<{ reason: string; ref?: string; credits: number }> {
  return (deps.store as unknown as { ledger: Array<{ reason: string; ref?: string; credits: number }> }).ledger;
}

const GENERATIVE = new Set(["lifestyle", "shopify_hero"]);

/** Asserts the degraded pack: every deterministic shot delivered and
 * charged, every generative shot paused with the given reason, released,
 * with one asset row each. */
function expectDegradedPack(
  deps: PipelineDeps,
  summary: Awaited<ReturnType<typeof runGeneratePack>>,
  generativeReason: string,
): void {
  expect(summary.state).toBe("done");
  const assets = assetsOf(deps);
  const generative = assets.filter((a) => GENERATIVE.has(a.shotType));
  const stills = assets.filter((a) => !GENERATIVE.has(a.shotType));
  expect(generative.length).toBeGreaterThan(0);
  expect(stills.some((a) => a.shotType === "amazon_main" && a.status === "passed")).toBe(true);
  for (const asset of generative) {
    expect(asset.status).toBe("needs_review");
    expect(asset.verdict.repairHint).toBe(generativeReason);
  }
  // One asset row per shot, even for retried shots.
  expect(new Set(assets.map((a) => a.shotId)).size).toBe(assets.length);
  // Only delivered shots are charged; paused ones are released.
  const charged = ledgerOf(deps).filter((e) => e.reason === "charge");
  const chargedRefs = new Set(charged.map((e) => e.ref));
  for (const asset of generative) expect(chargedRefs.has(asset.shotId)).toBe(false);
  const passedCredits = assets.filter((a) => a.status === "passed").reduce((sum, a) => sum + a.credits, 0);
  expect(summary.chargedCredits).toBe(passedCredits);
  expect(summary.chargedCredits + summary.releasedCredits).toBe(summary.reservedCredits);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chaos: the scene image chain is down (1.3, 1.4)", () => {
  it("every image provider 5xx: delivers the deterministic files, pauses scenes after one delayed retry", async () => {
    const run = await chaosDeps(() => new ProviderError("gemini responded 503: overloaded", "x", SCENE_PLATE_TASK, true));
    const summary = await runGeneratePack(packInput, run.deps);
    expectDegradedPack(run.deps, summary, SHOT_SCENE_PAUSED);
    expect(run.sleeps).toEqual([DEFAULT_DELAYED_RETRY_MS]);
    expect(run.quota).toEqual([]);
  }, 180_000);

  it("429 on every image provider is transient: one delayed retry, then paused", async () => {
    const run = await chaosDeps(() => httpProviderError("openai-image", SCENE_PLATE_TASK, 429, '{"error":{"code":"rate_limit_exceeded"}}'));
    const summary = await runGeneratePack(packInput, run.deps);
    expectDegradedPack(run.deps, summary, SHOT_SCENE_PAUSED);
    expect(run.sleeps).toEqual([DEFAULT_DELAYED_RETRY_MS]);
  }, 180_000);

  it("timeouts on every image provider are transient: one delayed retry, then paused", async () => {
    const run = await chaosDeps(() => new ProviderTimeoutError("gemini-image", SCENE_PLATE_TASK, 60_000));
    const summary = await runGeneratePack(packInput, run.deps);
    expectDegradedPack(run.deps, summary, SHOT_SCENE_PAUSED);
    expect(run.sleeps).toEqual([DEFAULT_DELAYED_RETRY_MS]);
  }, 180_000);

  it("401 is not transient: no delayed retry, the scenes go to review and the rest ships", async () => {
    const run = await chaosDeps(() => httpProviderError("bfl-flux", SCENE_PLATE_TASK, 401, '{"detail":"bad key"}'));
    const summary = await runGeneratePack(packInput, run.deps);
    expectDegradedPack(run.deps, summary, SHOT_PROVIDER_TROUBLE);
    expect(run.sleeps).toEqual([]);
  }, 180_000);

  it("402 quota on every image provider: breakers open for quota at once, no retry, scenes paused", async () => {
    const providers: FailingImageProvider[] = [];
    const run = await chaosDeps(() => httpProviderError("bfl-flux", SCENE_PLATE_TASK, 402, '{"detail":"Insufficient credits"}'));
    for (const name of IMAGE_PROVIDERS) providers.push(run.deps.ai.registry.get(name) as FailingImageProvider);
    const summary = await runGeneratePack(packInput, run.deps);
    expectDegradedPack(run.deps, summary, SHOT_SCENE_PAUSED);
    expect(run.sleeps).toEqual([]);
    // Each provider was asked once: the quota answer opened its breaker.
    for (const provider of providers) expect(provider.calls).toBe(1);
    const breaker = new CircuitBreaker(run.breakerStore);
    for (const name of IMAGE_PROVIDERS) expect(await breaker.openReason(name)).toBe("quota");
    expect(run.quota.map((q) => q.provider).sort()).toEqual([...IMAGE_PROVIDERS].sort());
  }, 180_000);
});

/** A fetch stub for the fal queue: the submit answers `status` with `body`. */
function falFetch(status: number, body: string): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function falCutout(fetchFn: typeof fetch): FalCutoutProvider {
  const row = cutoutModelSeedRows[0];
  return new FalCutoutProvider({
    name: row.providerName,
    tasks: [CUTOUT_TASK],
    apiKey: "fal-test-key",
    modelId: row.model,
    modelParams: row.params,
    priceTable: { perCallMicros: row.perCallMicros },
    fetchFn,
  });
}

describe("chaos: the cutout chain (1.2)", () => {
  it("a fal 402 exhausted balance fails the pack cleanly: nothing charged, one call, breaker open for quota", async () => {
    const fal = falFetch(402, '{"detail":"Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}');
    const run = await chaosDeps(null, falCutout(fal.fetchFn));
    const summary = await runGeneratePack(packInput, run.deps);
    expect(summary.state).toBe("failed");
    expect(summary.chargedCredits).toBe(0);
    // Every shot starts from the one cutout: the quota answer tripped the
    // breaker, so fal was asked once and never retried.
    expect(fal.calls).toHaveLength(1);
    expect(await new CircuitBreaker(run.breakerStore).openReason(CUTOUT)).toBe("quota");
    expect(run.quota).toEqual([expect.objectContaining({ provider: CUTOUT, task: CUTOUT_TASK })]);
    expect(run.sleeps).toEqual([]);
  }, 120_000);

  it("an exhausted fal balance fails over to the backup fal account and the pack is delivered (audit 2026-09-29)", async () => {
    const fal = falFetch(403, '{"detail":"Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}');
    const run = await chaosDeps(null, falCutout(fal.fetchFn));
    const backupName = cutoutModelSeedRows[1].providerName;
    const backup = new GoodCutout(await cutoutPng(), backupName);
    run.deps.ai.registry.register(backup);
    run.deps.ai.routing[CUTOUT_TASK] = [CUTOUT, backupName];
    const summary = await runGeneratePack(packInput, run.deps);
    expect(summary.state).toBe("done");
    expect(summary.chargedCredits).toBeGreaterThan(0);
    expect(fal.calls).toHaveLength(1);
    expect(backup.calls).toBeGreaterThan(0);
    expect(await new CircuitBreaker(run.breakerStore).openReason(CUTOUT)).toBe("quota");
  }, 120_000);

  it("a fal 5xx is transient: the pack retries once after the delay, then fails with nothing charged", async () => {
    const fal = falFetch(503, '{"detail":"service unavailable"}');
    const run = await chaosDeps(null, falCutout(fal.fetchFn));
    run.deps.ai.routing[CUTOUT_TASK] = [CUTOUT];
    const summary = await runGeneratePack(packInput, run.deps);
    expect(summary.state).toBe("failed");
    expect(summary.chargedCredits).toBe(0);
    expect(run.sleeps).toEqual([DEFAULT_DELAYED_RETRY_MS]);
  }, 120_000);

  it("without FAL_KEY there is no cutout route, and a Photoroom key is ignored", () => {
    const registry = new ProviderRegistry();
    const routing = demoRoutingTable();
    const wiring = wireLiveProviders(registry, routing, (name) => (name === "PHOTOROOM_API_KEY" ? "pr-key" : undefined));
    expect(wiring.cutoutLive).toBe(false);
    expect(wiring.cutoutProviders).toEqual([]);
    expect(routing[CUTOUT_TASK]).toBeUndefined();
    expect(registry.get("photoroom")).toBeUndefined();
  });

  it("with FAL_KEY the cutout chain is the seeded fal BiRefNet model", () => {
    const registry = new ProviderRegistry();
    const routing = demoRoutingTable();
    const wiring = wireLiveProviders(registry, routing, (name) => (name === "FAL_KEY" ? "fal-key" : undefined));
    expect(wiring.cutoutProviders).toEqual(["fal-birefnet"]);
    expect(routing[CUTOUT_TASK]).toEqual(["fal-birefnet"]);
    expect(registry.get("fal-birefnet")?.kind).toBe("cutout");
    expect(registry.get("fal-birefnet-backup")).toBeUndefined();
  });

  it("with a second fal account key the chain fails over to the backup row, in seed order", () => {
    const registry = new ProviderRegistry();
    const routing = demoRoutingTable();
    const keys: Record<string, string> = { FAL_KEY: "fal-key", FAL_KEY_BACKUP: "fal-backup-key" };
    const wiring = wireLiveProviders(registry, routing, (name) => keys[name]);
    expect(cutoutModelSeedRows.map((row) => row.keyEnv)).toEqual(["FAL_KEY", "FAL_KEY_BACKUP"]);
    expect(wiring.cutoutProviders).toEqual(cutoutModelSeedRows.map((row) => row.providerName));
    expect(routing[CUTOUT_TASK]).toEqual(["fal-birefnet", "fal-birefnet-backup"]);
    // Same MIT BiRefNet model and parameters on both accounts.
    expect(cutoutModelSeedRows[1].model).toBe(cutoutModelSeedRows[0].model);
    expect(cutoutModelSeedRows[1].params).toEqual(cutoutModelSeedRows[0].params);
  });

  it("with only the backup fal key the cutout stage still runs", () => {
    const registry = new ProviderRegistry();
    const routing = demoRoutingTable();
    const wiring = wireLiveProviders(registry, routing, (name) => (name === "FAL_KEY_BACKUP" ? "k" : undefined));
    expect(wiring.cutoutLive).toBe(true);
    expect(routing[CUTOUT_TASK]).toEqual(["fal-birefnet-backup"]);
  });
});
