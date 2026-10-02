import { spendCapPolicy as SPEND_CAPS } from "@curvi/pipeline/seed";
import { describe, expect, it, vi } from "vitest";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry, type RoutingTable } from "@curvi/ai";
import { InMemoryCapStore, MockProvider } from "@curvi/ai/testing";
import { SpendCaps } from "@curvi/ai";
import { decodeToRgba, encodePng, prepareWorkingSource, rawToSharp, type IntakeImageResult, type RawImage } from "@curvi/pipeline";
import { CUTOUT_TASK } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import { hasFreshUploadCutout, WORKING_SOURCE_MAX_PX } from "./live-runtime";
import { activeRecipe, InMemoryJobStore, systemClock, type AiDeps, type PipelineDeps } from "./pipeline-runner";
import { claimedCutoutCacheKey, PREVIEW_SPEND_KEY, runFreePreview } from "./free-preview";
import { DemoShotGenerator } from "./runtime";

// docs/phases/PHASE_18.md P18-12, runner side: the free white main image
// runs intake and moderation first, pays for one cutout through the router,
// renders amazon.main from the real cutout with the pack's renderer and
// ships only bytes that pass fidelityReport (CLAUDE.md rule 3).

const mutate = vi.hoisted(() => ({ on: false }));

vi.mock("./live-deterministic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live-deterministic")>();
  return {
    ...actual,
    renderOnBackground: async (...args: Parameters<typeof actual.renderOnBackground>) => {
      const still = await actual.renderOnBackground(...args);
      if (!mutate.on) {
        return still;
      }
      // A render that changed product pixels: paint over the middle of the
      // product in the shipped file, the way a regenerating model would.
      const decoded = await decodeToRgba(still.encoded.buffer);
      const { width, height } = decoded;
      for (let y = Math.floor(height * 0.4); y < Math.floor(height * 0.6); y++) {
        for (let x = Math.floor(width * 0.4); x < Math.floor(width * 0.6); x++) {
          const o = (y * width + x) * 4;
          decoded.data[o] = 20;
          decoded.data[o + 1] = 200;
          decoded.data[o + 2] = 40;
        }
      }
      const buffer = await rawToSharp(decoded).jpeg({ quality: 95 }).toBuffer();
      return { ...still, encoded: { buffer, format: "jpeg" } };
    },
  };
});

const PREVIEW_ID = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";
const intakeKey = activeRecipe("intake").key;
const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };

function imageResult(overrides: Partial<IntakeImageResult> = {}): IntakeImageResult {
  return {
    sellableProduct: true,
    distinctProducts: 1,
    sharpEnough: true,
    screenshot: false,
    products: [{ label: "candle", box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, matchesIntent: "unclear" }],
    addedOverlays: false,
    restrictedCategory: null,
    flags,
    ...overrides,
  };
}

/** A 400 by 300 photo: a textured candle on a gray table. */
function photo(): RawImage {
  const width = 400;
  const height = 300;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inside = x >= 120 && x < 280 && y >= 60 && y < 240;
      data[o] = inside ? 200 + ((x * 3) % 40) : 170;
      data[o + 1] = inside ? 90 + ((y * 5) % 50) : 170;
      data[o + 2] = inside ? 120 : 170;
      data[o + 3] = 255;
    }
  }
  return { data, width, height, channels: 4 };
}

/** The cutout a provider returns for the upright working copy: the candle
 * opaque, everything else transparent (or, opaque, a failed segmentation). */
async function cutoutFor(bytes: Buffer, opaqueEverywhere = false): Promise<Uint8Array> {
  const upright = await decodeToRgba(await prepareWorkingSource(bytes, WORKING_SOURCE_MAX_PX));
  const data = Buffer.from(upright.data);
  for (let y = 0; y < upright.height; y++) {
    for (let x = 0; x < upright.width; x++) {
      const inside = x >= 120 && x < 280 && y >= 60 && y < 240;
      data[(y * upright.width + x) * 4 + 3] = inside || opaqueEverywhere ? 255 : 0;
    }
  }
  return new Uint8Array(await encodePng({ ...upright, data }));
}

interface Setup {
  deps: PipelineDeps;
  intake: MockProvider;
  cutout: MockProvider | null;
  meter: InMemoryCostMeter;
}

async function setup(opts: {
  intakeOutput?: unknown;
  intakeFails?: boolean;
  cutout?: "ok" | "opaque" | "none";
  bytes: Buffer;
}): Promise<Setup> {
  const intake = new MockProvider({
    name: "mock-intake",
    tasks: [intakeKey],
    output: opts.intakeOutput ?? { images: [imageResult()] },
    costMicros: 1_000,
    estimateMicros: 1_000,
    ...(opts.intakeFails ? { failTimes: Infinity } : {}),
  });
  const registry = new ProviderRegistry();
  registry.register(intake);
  const routing: RoutingTable = { [intakeKey]: [intake.name] };
  let cutout: MockProvider | null = null;
  if (opts.cutout !== "none") {
    cutout = new MockProvider({
      name: "fal-birefnet",
      kind: "cutout",
      tasks: [CUTOUT_TASK],
      output: { imageBytes: await cutoutFor(opts.bytes, opts.cutout === "opaque"), contentType: "image/png" },
      costMicros: 10_000,
      estimateMicros: 10_000,
    });
    registry.register(cutout);
    routing[CUTOUT_TASK] = [cutout.name];
  }
  const meter = new InMemoryCostMeter();
  const ai: AiDeps = {
    registry,
    routing,
    meter,
    breakerStore: new InMemoryBreakerStore(),
    caps: new SpendCaps(new InMemoryCapStore(), () => new Date(), SPEND_CAPS),
  };
  const deps: PipelineDeps = { ai, store: new InMemoryJobStore(), clock: systemClock, generator: new DemoShotGenerator() };
  return { deps, intake, cutout, meter };
}

describe("runFreePreview", () => {
  it("makes a measured white main image from the real cutout, metered on the preview key", async () => {
    const bytes = await encodePng(photo());
    const { deps, intake, cutout, meter } = await setup({ bytes });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });

    expect(run.status).toBe("done");
    expect(run.reason).toBeNull();
    expect(intake.invocations).toBe(1);
    expect(cutout?.invocations).toBe(1);
    // The cutout runs with no workspace, so the R2 cutout cache is never
    // written under a made up workspace; the LLM call is booked on "preview".
    expect(cutout?.calls[0].workspaceId).toBeUndefined();
    expect(cutout?.calls[0].jobId).toBe(`${PREVIEW_SPEND_KEY}:${PREVIEW_ID}`);
    expect(intake.calls[0].workspaceId).toBe(PREVIEW_SPEND_KEY);
    expect(run.costMicros).toBe(11_000);
    expect(meter.totalForJob(`${PREVIEW_SPEND_KEY}:${PREVIEW_ID}`)).toBe(11_000);

    // The full size file is amazon.main as a pack would ship it, and it
    // passes the rule 3 check; the preview is a small JPEG of it.
    const spec = getSpec("amazon.main");
    expect(["jpeg", "png"]).toContain(run.main?.format);
    expect(Math.max(run.main?.width ?? 0, run.main?.height ?? 0)).toBe(Math.max(spec.width ?? 0, spec.height ?? 0));
    expect(run.fidelity?.pass).toBe(true);
    expect(run.fidelity?.meanDeltaE).toBeLessThan(run.fidelity?.threshold ?? 0);
    const preview = await decodeToRgba(run.preview ?? Buffer.alloc(0));
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(1000);
    expect(run.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["backgroundWhiteShare", "fillRatio"]));
    expect(run.checksPass).toBe(true);
    expect(run.fillPct).toBeGreaterThan(0);
    expect(run.cutout?.contentType).toBe("image/png");
  });

  it("never ships a render whose product pixels changed", async () => {
    const bytes = await encodePng(photo());
    const { deps } = await setup({ bytes });
    mutate.on = true;
    try {
      const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
      expect(run.status).toBe("failed");
      expect(run.reason).toBe("fidelity");
      expect(run.fidelity?.pass).toBe(false);
      expect(run.main).toBeNull();
      expect(run.preview).toBeNull();
      // The cutout was paid for, so its cost is still booked.
      expect(run.costMicros).toBe(11_000);
    } finally {
      mutate.on = false;
    }
  });

  it("stops at moderation before any cutout is paid for", async () => {
    const bytes = await encodePng(photo());
    const { deps, cutout } = await setup({
      bytes,
      intakeOutput: { images: [imageResult({ flags: { ...flags, weapons: true } })] },
    });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
    expect(run).toMatchObject({ status: "blocked", reason: "moderation", moderation: ["weapons"], costMicros: 1_000 });
    expect(cutout?.invocations).toBe(0);
    expect(run.main).toBeNull();
  });

  it("stops when intake sees no sellable product", async () => {
    const bytes = await encodePng(photo());
    const { deps, cutout } = await setup({ bytes, intakeOutput: { images: [imageResult({ sellableProduct: false })] } });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
    expect(run).toMatchObject({ status: "blocked", reason: "no_product" });
    expect(cutout?.invocations).toBe(0);
  });

  it("fails closed when intake cannot answer, so nothing skips moderation", async () => {
    const bytes = await encodePng(photo());
    const { deps, cutout } = await setup({ bytes, intakeFails: true });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
    expect(run).toMatchObject({ status: "unavailable", reason: "intake_unavailable" });
    expect(cutout?.invocations).toBe(0);
  });

  it("reports the cutout chain as unavailable when no cutout provider is configured", async () => {
    const bytes = await encodePng(photo());
    const { deps } = await setup({ bytes, cutout: "none" });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
    expect(run).toMatchObject({ status: "unavailable", reason: "cutout_unavailable", main: null });
  });

  it("names the cache key the first pack of the claiming workspace reads, so it pays for no second cutout", async () => {
    const bytes = await encodePng(photo());
    const ws = "00000000-0000-4000-8000-000000001202";
    const key = await claimedCutoutCacheKey(ws, bytes);
    expect(key).toMatch(new RegExp(`^tmp/ws/${ws}/cache/cutout/[0-9a-f]{64}\\.png$`));
    const stored = new Map([[key, { bytes: Buffer.from("png"), contentType: "image/png", storedAt: new Date() }]]);
    const store = { get: async (k: string) => stored.get(k) ?? null, put: async () => undefined };
    expect(await hasFreshUploadCutout(ws, bytes, { store })).toBe(true);
    expect(await hasFreshUploadCutout("00000000-0000-4000-8000-000000001203", bytes, { store })).toBe(false);
  });

  it("refuses a cutout that kept the whole photo", async () => {
    const bytes = await encodePng(photo());
    const { deps } = await setup({ bytes, cutout: "opaque" });
    const run = await runFreePreview(deps, { previewId: PREVIEW_ID, bytes, previewLongSide: 1000 });
    expect(run).toMatchObject({ status: "failed", reason: "segmentation", main: null });
    expect(run.costMicros).toBe(11_000);
  });
});
