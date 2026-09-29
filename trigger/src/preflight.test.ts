import { describe, expect, it } from "vitest";
import {
  callWithFailover,
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderRegistry,
  type RoutingTable,
} from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { analyzeInventory, decodeToRgba, encodePng, type IntakeImageResult, type RawImage } from "@curvi/pipeline";
import { CUTOUT_TASK } from "@curvi/pipeline/seed";
import { cacheCutouts, cutoutCacheKey, type CachedCutout, type CutoutCacheStore } from "./cutout-cache";
import {
  activeRecipe,
  InMemoryJobStore,
  inventorySelection,
  runGeneratePack,
  selectTargets,
  SELLER_PICKED_LABEL,
  systemClock,
  type AiDeps,
  type GeneratePackInput,
  type PipelineDeps,
  type ShotGenerator,
} from "./pipeline-runner";
import { CUTOUT_PREVIEW_LONG_SIDE, runUploadPreflight, unionBox } from "./preflight";
import { noteKey, PREFLIGHT_FRESH_MS, reusablePreflightIntake, type PreflightIntake } from "./preflight-intake";
import { demoProfile, DemoShotGenerator } from "./runtime";

// docs/phases/PHASE_14.md workstream 4 and item 3.2, runner side.

const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const KEY = `ws/${WS}/src/photo`;
const intakeRecipe = activeRecipe("intake");
const intakeKey = intakeRecipe.key;
const analyzeKey = activeRecipe("analyze").key;
const planKey = activeRecipe("plan").key;
const qcKey = activeRecipe("qc").key;

const flags = { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false };
const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 40, 200];
const redBox = { x: 0.1, y: 50 / 300, width: 0.375, height: 200 / 300 };
const blueBox = { x: 0.5, y: 50 / 300, width: 0.375, height: 200 / 300 };

function twoBottles(): RawImage {
  const width = 400;
  const height = 300;
  const data = Buffer.alloc(width * height * 4, 0);
  for (const [left, rgb] of [
    [40, RED],
    [200, BLUE],
  ] as const) {
    for (let y = 50; y < 250; y++) {
      for (let x = left; x < left + 150; x++) {
        const o = (y * width + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  }
  return { data, width, height, channels: 4 };
}

const twoProductsImage: IntakeImageResult = {
  sellableProduct: true,
  distinctProducts: 2,
  sharpEnough: true,
  screenshot: false,
  products: [
    { label: "red bottle", box: redBox, matchesIntent: "unclear" },
    { label: "blue bottle", box: blueBox, matchesIntent: "unclear" },
  ],
  addedOverlays: false,
  flags,
};

function makeAi(intakeOutput: unknown, intakeCost = 800): { ai: AiDeps; intake: MockProvider } {
  const intake = new MockProvider({ name: "mock-intake", tasks: [intakeKey], output: intakeOutput, costMicros: intakeCost });
  const analyze = new MockProvider({ name: "mock-analyze", tasks: [analyzeKey], output: demoProfile });
  const plan = new MockProvider({ name: "mock-plan", tasks: [planKey], output: { notAShotList: true } });
  const qc = new MockProvider({
    name: "mock-qc",
    tasks: [qcKey],
    output: { pass: true, fidelity: 0.97, issues: [], repairHint: "" },
  });
  const registry = new ProviderRegistry();
  for (const p of [intake, analyze, plan, qc]) registry.register(p);
  const routing: RoutingTable = {
    [intakeKey]: [intake.name],
    [analyzeKey]: [analyze.name],
    [planKey]: [plan.name],
    [qcKey]: [qc.name],
  };
  return {
    ai: { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() },
    intake,
  };
}

function preflightOf(image: IntakeImageResult, overrides: Partial<PreflightIntake> = {}): PreflightIntake {
  return {
    image,
    noteKey: noteKey(undefined),
    recipe: { key: intakeRecipe.key, version: intakeRecipe.version },
    at: new Date().toISOString(),
    ...overrides,
  };
}

class MemoryCache implements CutoutCacheStore {
  readonly items = new Map<string, CachedCutout>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    this.items.set(key, { bytes, contentType, storedAt: this.clock() });
  }
}

describe("cutout cache", () => {
  function setup(store: CutoutCacheStore, now?: () => Date) {
    const provider = new MockProvider({
      name: "photoroom",
      kind: "cutout",
      tasks: [CUTOUT_TASK],
      output: { imageBytes: new Uint8Array([1, 2, 3]), contentType: "image/png" },
      costMicros: 20_000,
    });
    const registry = new ProviderRegistry();
    registry.register(provider);
    expect(cacheCutouts(registry, store, now ? { now } : {})).toEqual(["photoroom"]);
    // Wrapping twice is a no op.
    expect(cacheCutouts(registry, store)).toEqual([]);
    const call = (workspaceId: string, bytes: Uint8Array) =>
      callWithFailover<{ imageBytes: Uint8Array; format: string }, { imageBytes: Uint8Array }>(
        registry,
        { [CUTOUT_TASK]: ["photoroom"] },
        new InMemoryCostMeter(),
        new InMemoryBreakerStore(),
        { task: CUTOUT_TASK, input: { imageBytes: bytes, format: "png" }, workspaceId, jobId: "j", stepId: "s" },
      );
    return { provider, call };
  }

  it("pays for a photo once per workspace: the second cutout is free", async () => {
    const store = new MemoryCache();
    const { provider, call } = setup(store);
    const photo = new Uint8Array([9, 9, 9]);
    const first = await call(WS, photo);
    expect(first.costMicros).toBe(20_000);
    const second = await call(WS, photo);
    expect(second.costMicros).toBe(0);
    expect([...second.output.imageBytes]).toEqual([1, 2, 3]);
    expect(provider.invocations).toBe(1);
    expect(store.items.has(cutoutCacheKey(WS, photo))).toBe(true);
    // Another workspace never reads this workspace's cutout.
    await call("9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f", photo);
    expect(provider.invocations).toBe(2);
    // Other bytes are another photo.
    await call(WS, new Uint8Array([8]));
    expect(provider.invocations).toBe(3);
  });

  it("calls the provider again once the cached cutout is stale", async () => {
    let now = new Date("2026-09-29T10:00:00Z");
    const store = new MemoryCache(() => now);
    const { provider, call } = setup(store, () => now);
    const photo = new Uint8Array([7]);
    await call(WS, photo);
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    await call(WS, photo);
    expect(provider.invocations).toBe(2);
  });

  it("never fails the call when the cache cannot be read or written", async () => {
    const broken: CutoutCacheStore = {
      get: async () => {
        throw new Error("r2 down");
      },
      put: async () => {
        throw new Error("r2 down");
      },
    };
    const { provider, call } = setup(broken);
    const result = await call(WS, new Uint8Array([1]));
    expect(result.costMicros).toBe(20_000);
    expect(provider.invocations).toBe(1);
  });

  it("keys the cache under the workspace prefix", () => {
    expect(cutoutCacheKey(WS, new Uint8Array([1]))).toMatch(new RegExp(`^ws/${WS}/cache/cutout/[0-9a-f]{64}\\.png$`));
  });
});

describe("reusablePreflightIntake", () => {
  const now = new Date();
  const recipe = { key: intakeRecipe.key, version: intakeRecipe.version };

  it("reuses fresh answers given for the same note and recipe, in photo order", () => {
    const intent = { featureOnly: "blue bottle", exclude: [], mustKeep: [], styleNotes: null };
    const reused = reusablePreflightIntake(
      [
        { preflight: preflightOf(twoProductsImage, { noteKey: noteKey(" blue bottle "), sellerIntent: intent }) },
        { preflight: preflightOf({ ...twoProductsImage, distinctProducts: 1 }, { noteKey: noteKey("blue bottle") }) },
      ],
      "blue bottle",
      recipe,
      now,
    );
    expect(reused?.images.map((i) => i.distinctProducts)).toEqual([2, 1]);
    expect(reused?.sellerIntent).toEqual(intent);
  });

  it("refuses a changed note, another recipe version, a stale answer or a photo without one", () => {
    const fresh = { preflight: preflightOf(twoProductsImage) };
    expect(reusablePreflightIntake([fresh], "the red one", recipe, now)).toBeNull();
    expect(reusablePreflightIntake([fresh], undefined, { ...recipe, version: recipe.version + 1 }, now)).toBeNull();
    const stale = { preflight: preflightOf(twoProductsImage, { at: new Date(now.getTime() - PREFLIGHT_FRESH_MS - 1).toISOString() }) };
    expect(reusablePreflightIntake([stale], undefined, recipe, now)).toBeNull();
    expect(reusablePreflightIntake([fresh, {}], undefined, recipe, now)).toBeNull();
    expect(reusablePreflightIntake([], undefined, recipe, now)).toBeNull();
    const broken = { preflight: preflightOf({ nope: true } as unknown as IntakeImageResult) };
    expect(reusablePreflightIntake([broken], undefined, recipe, now)).toBeNull();
    expect(reusablePreflightIntake([fresh], "", recipe, now)).not.toBeNull();
  });

  it("keeps the added text flag on a reused answer", () => {
    const flagged = { preflight: preflightOf({ ...twoProductsImage, addedOverlays: true }) };
    expect(reusablePreflightIntake([flagged], undefined, recipe, now)?.images[0].addedOverlays).toBe(true);
  });
});

describe("a stored target box in the runner", () => {
  const withYesOnBlue = {
    images: [
      {
        ...twoProductsImage,
        products: [
          { label: "red bottle", box: redBox, matchesIntent: "no" as const },
          { label: "blue bottle", box: blueBox, matchesIntent: "yes" as const },
        ],
      },
    ],
  };

  it("selectTargets takes the seller's box over intake's yes", () => {
    const legacy = selectTargets(withYesOnBlue, [{ mediaId: "m1" }], "job");
    expect(legacy.targets.m1.label).toBe("blue bottle");
    const chosen = selectTargets(withYesOnBlue, [{ mediaId: "m1", targetBox: redBox }], "job");
    expect(chosen.targets.m1).toEqual({
      label: "red bottle",
      box: redBox,
      others: [{ label: "blue bottle", box: blueBox }],
    });
    expect(chosen.ambiguous).toEqual([]);
  });

  it("selectTargets settles an ambiguous photo and works without intake products", () => {
    const unsure = { images: [twoProductsImage] };
    expect(selectTargets(unsure, [{ mediaId: "m1" }], "job").ambiguous).toEqual(["m1"]);
    const chosen = selectTargets(unsure, [{ mediaId: "m1", targetBox: blueBox }], "job");
    expect(chosen.ambiguous).toEqual([]);
    expect(chosen.targets.m1.box).toEqual(blueBox);
    const bare = selectTargets(
      { images: [{ sellableProduct: true, distinctProducts: 1, sharpEnough: true, addedOverlays: false, flags }] },
      [{ mediaId: "m1", targetBox: blueBox }],
      "job",
    );
    expect(bare.targets.m1).toEqual({ label: SELLER_PICKED_LABEL, box: blueBox, others: [] });
  });

  it("inventorySelection features the tapped piece and removes the other", () => {
    const inventory = analyzeInventory(twoBottles());
    const cutouts = new Map([["m1", inventory]]);
    const { selection, photos } = inventorySelection(
      withYesOnBlue,
      [{ mediaId: "m1", targetBox: redBox }],
      cutouts,
      "blue only",
      "job",
    );
    expect(photos[0].decision).toMatchObject({ rule: "seller", featured: [0], removed: [1] });
    expect(selection.targets.m1.label).toBe("red bottle");
    expect(selection.targets.m1.others.map((o) => o.label)).toEqual(["blue bottle"]);
    expect(selection.ambiguous).toEqual([]);
    // Without a stored box the existing rules still decide.
    const legacy = inventorySelection(withYesOnBlue, [{ mediaId: "m1" }], cutouts, "blue only", "job");
    expect(legacy.photos[0].decision.rule).toBe("model");
  });
});

describe("runGeneratePack with a preflight", () => {
  const input: GeneratePackInput = {
    jobId: "job-preflight",
    workspaceId: "ws1",
    tier: "starter",
    channels: ["amazon.main"],
    creditBudget: 20,
    images: [{ mediaId: "m1" }],
    sku: "SKU1",
    seoSlug: "watch",
  };
  const single: IntakeImageResult = { sellableProduct: true, distinctProducts: 1, sharpEnough: true, addedOverlays: false, flags };

  function deps(ai: AiDeps): PipelineDeps & { store: InMemoryJobStore } {
    return { ai, store: new InMemoryJobStore(), clock: systemClock, generator: new DemoShotGenerator() };
  }

  it("reuses the preflight intake answer instead of calling intake again", async () => {
    const { ai, intake } = makeAi({ images: [single] });
    const summary = await runGeneratePack(
      { ...input, images: [{ mediaId: "m1", preflight: preflightOf(single) }] },
      deps(ai),
    );
    expect(summary.state).toBe("done");
    expect(intake.invocations).toBe(0);
  });

  it("asks intake again when the note changed since the preflight", async () => {
    const { ai, intake } = makeAi({ images: [single] });
    const summary = await runGeneratePack(
      { ...input, userDescription: "the silver one", images: [{ mediaId: "m1", preflight: preflightOf(single) }] },
      deps(ai),
    );
    expect(summary.state).toBe("done");
    expect(intake.invocations).toBe(1);
  });

  it("never sends the stored box or the preflight answer to a prompt", async () => {
    const { ai, intake } = makeAi({ images: [single] });
    await runGeneratePack(
      {
        ...input,
        userDescription: "changed",
        images: [{ mediaId: "m1", targetBox: blueBox, preflight: preflightOf(single) }],
      },
      deps(ai),
    );
    const sent = JSON.stringify(intake.calls[0]?.input);
    expect(sent).toContain("m1");
    expect(sent).not.toContain("preflight");
    expect(sent).not.toContain("targetBox");
  });
});

describe("runUploadPreflight", () => {
  const photo = async () => encodePng(twoBottles());

  function generator(cutout: RawImage | null, costMicros = 20_000): ShotGenerator {
    const demo = new DemoShotGenerator();
    return {
      generate: (args) => demo.generate(args),
      inventoryCutout: async () => ({ cutout, costMicros }),
    } as ShotGenerator;
  }

  function preflightDeps(intakeOutput: unknown, gen: ShotGenerator): { deps: PipelineDeps; intake: MockProvider } {
    const { ai, intake } = makeAi(intakeOutput);
    const bytes = photo();
    return {
      deps: {
        ai,
        store: new InMemoryJobStore(),
        clock: systemClock,
        generator: gen,
        loadMedia: async (key) => (key === KEY ? bytes : null),
      },
      intake,
    };
  }

  it("runs intake, moderation and the inventory, with thumbnails for the chooser", async () => {
    const { deps, intake } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-1", workspaceId: WS, mediaKey: KEY, note: "" });
    expect(intake.invocations).toBe(1);
    expect(intake.calls[0].jobId).toBe("pf-1");
    expect(run.photo).toEqual({ width: 400, height: 300 });
    expect(run.moderation).toEqual([]);
    expect(run.cutout).toBe("done");
    expect(run.rule).toBe("ambiguous");
    expect(run.items.map((i) => i.label)).toEqual(["red bottle", "blue bottle"]);
    expect(run.items.map((i) => i.number)).toEqual([1, 2]);
    expect(run.thumbnails).toHaveLength(2);
    expect(run.costMicros).toBe(800 + 20_000);
    expect(run.intake).toMatchObject({ noteKey: noteKey(""), recipe: { key: intakeRecipe.key, version: intakeRecipe.version } });
  });

  it("carries intake version 5's added text flag, and reads an older answer as clean", async () => {
    const flagged = preflightDeps({ images: [{ ...twoProductsImage, addedOverlays: true }] }, generator(twoBottles()));
    const run = await runUploadPreflight(flagged.deps, { preflightId: "pf-ov", workspaceId: WS, mediaKey: KEY, note: "" });
    expect(run.intake?.image.addedOverlays).toBe(true);
    const { addedOverlays: _unused, ...older } = twoProductsImage;
    const clean = preflightDeps({ images: [older] }, generator(twoBottles()));
    const oldRun = await runUploadPreflight(clean.deps, { preflightId: "pf-old", workspaceId: WS, mediaKey: KEY, note: "" });
    expect(oldRun.intake?.image.addedOverlays).toBe(false);
  });

  it("preselects the piece the note decides", async () => {
    const { deps } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-2", workspaceId: WS, mediaKey: KEY, note: "the blue one only" });
    expect(run.rule).toBe("note");
    expect(run.items.filter((i) => i.featured).map((i) => i.label)).toEqual(["blue bottle"]);
    // The crop box is the featured piece's box (PHASE_15 P1).
    const blue = run.items.find((i) => i.featured)!;
    expect(run.productBox).toEqual(blue.box);
  });

  it("keeps the union of every piece as the product box when none is featured", async () => {
    const { deps } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-1b", workspaceId: WS, mediaKey: KEY, note: "" });
    expect(run.items.some((i) => i.featured)).toBe(false);
    const union = unionBox(run.items.map((i) => i.box))!;
    expect(run.productBox).toEqual(union);
    for (const item of run.items) {
      expect(item.box.x).toBeGreaterThanOrEqual(union.x);
      expect(item.box.x + item.box.width).toBeLessThanOrEqual(union.x + union.width + 1e-9);
    }
    expect(unionBox([])).toBeNull();
  });

  it("draws the cutout preview of the one product the pack is for (PHASE_15 P1)", async () => {
    const { deps } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-8", workspaceId: WS, mediaKey: KEY, note: "the blue one only" });
    expect(run.preview).not.toBeNull();
    const preview = await decodeToRgba(run.preview!);
    expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(CUTOUT_PREVIEW_LONG_SIDE);
    let clear = 0;
    let red = 0;
    for (let i = 0; i < preview.width * preview.height; i++) {
      const [r, g, b, a] = [0, 1, 2, 3].map((c) => preview.data[i * 4 + c]);
      if (a === 0) clear++;
      else if (r > 150 && g < 80 && b < 80) red++;
    }
    // Only the blue bottle's own pixels, on a clear background.
    expect(clear).toBeGreaterThan(0);
    expect(red).toBe(0);
  });

  it("draws no cutout preview while the photo needs the chooser", async () => {
    const { deps } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-9", workspaceId: WS, mediaKey: KEY, note: "" });
    expect(run.rule).toBe("ambiguous");
    expect(run.preview).toBeNull();
  });

  it("returns intake only and says so when the cutout provider is unavailable", async () => {
    const { deps } = preflightDeps({ images: [twoProductsImage] }, generator(null, 0));
    const run = await runUploadPreflight(deps, { preflightId: "pf-3", workspaceId: WS, mediaKey: KEY });
    expect(run.cutout).toBe("unavailable");
    expect(run.intake).not.toBeNull();
    expect(run.items).toEqual([]);
    const bare = preflightDeps({ images: [twoProductsImage] }, new DemoShotGenerator());
    expect((await runUploadPreflight(bare.deps, { preflightId: "pf-4", workspaceId: WS, mediaKey: KEY })).cutout).toBe(
      "unavailable",
    );
  });

  it("skips the paid cutout for a blocked photo", async () => {
    const cut = generator(twoBottles());
    let cutCalls = 0;
    const counting = { ...cut, inventoryCutout: async (a: never) => (cutCalls++, cut.inventoryCutout!(a)) } as ShotGenerator;
    const { deps } = preflightDeps({ images: [{ ...twoProductsImage, flags: { ...flags, weapons: true } }] }, counting);
    const run = await runUploadPreflight(deps, { preflightId: "pf-5", workspaceId: WS, mediaKey: KEY });
    expect(run.moderation).toEqual(["weapons"]);
    expect(run.cutout).toBe("skipped");
    expect(cutCalls).toBe(0);
  });

  it("never loads another workspace's photo", async () => {
    const { deps, intake } = preflightDeps({ images: [twoProductsImage] }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, {
      preflightId: "pf-6",
      workspaceId: "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
      mediaKey: KEY,
    });
    expect(run.missing).toBe(true);
    expect(intake.invocations).toBe(0);
  });

  it("books a failed intake's spend and stops", async () => {
    const { deps } = preflightDeps({ nope: true }, generator(twoBottles()));
    const run = await runUploadPreflight(deps, { preflightId: "pf-7", workspaceId: WS, mediaKey: KEY });
    expect(run.intake).toBeNull();
    expect(run.cutout).toBe("skipped");
    expect(run.costMicros).toBe(800);
  });
});
