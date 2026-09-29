/**
 * Scene variations in the runner (docs/phases/PHASE_16.md workstream 6,
 * founder decision 3): every version of a scene is its own generation
 * through the same composite and checks, the pack ships the scene itself,
 * extra versions are stored unpicked and never zipped, and each extra
 * version is charged exactly creditCosts.generativeStill, or released when
 * it does not pass.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry } from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { solidCanvas, type PackFileReport } from "@curvi/pipeline";
import {
  normalizeOutputOptions,
  resolveOutputOptions,
  type OutputOptionsInput,
  type ResolvedOutputOptions,
} from "@curvi/pipeline/output-options";
import { creditCosts, stillStyle } from "@curvi/pipeline/seed";
import { parseVariationShotId } from "@curvi/pipeline/variations";
import {
  activeRecipe,
  InMemoryJobStore,
  runGeneratePack,
  systemClock,
  type AiDeps,
  type GeneratePackInput,
  type PipelineDeps,
  type ShotGenerateArgs,
  type ShotGeneration,
  type ShotGenerator,
  type StoredPack,
} from "./pipeline-runner";
import { demoAplusCopy, demoProfile, DemoShotGenerator } from "./runtime";

const keys = {
  intake: activeRecipe("intake").key,
  analyze: activeRecipe("analyze").key,
  plan: activeRecipe("plan").key,
  qc: activeRecipe("qc").key,
  copy: activeRecipe("copy").key,
};

const intakeFixture = {
  images: [
    {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    },
  ],
};

function makeAi(): AiDeps {
  const providers = [
    new MockProvider({ name: "mock-intake", tasks: [keys.intake], output: intakeFixture }),
    new MockProvider({ name: "mock-analyze", tasks: [keys.analyze], output: demoProfile }),
    new MockProvider({ name: "mock-plan", tasks: [keys.plan], output: { notAShotList: true } }),
    new MockProvider({ name: "mock-qc", tasks: [keys.qc], output: { pass: true, fidelity: 0.97, issues: [], repairHint: "" } }),
    new MockProvider({ name: "mock-copy", tasks: [keys.copy], output: demoAplusCopy }),
  ];
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return {
    registry,
    routing: Object.fromEntries(Object.values(keys).map((key, i) => [key, [providers[i].name]])),
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
}

/** Counts every generation and can fail the ones named. */
class CountingGenerator implements ShotGenerator {
  private readonly demo = new DemoShotGenerator();
  readonly calls: ShotGenerateArgs[] = [];
  constructor(private readonly failIds: ReadonlySet<string> = new Set()) {}

  async generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    this.calls.push(args);
    if (this.failIds.has(args.shot.id)) {
      // Far below every spec's minimum size, so the checks turn it down.
      return {
        image: solidCanvas(64, 64, 255, 255, 255),
        mask: null,
        encoded: { buffer: Buffer.from("stub"), format: "png" },
        costMicros: 0,
      };
    }
    return this.demo.generate(args);
  }
}

function resolved(input: OutputOptionsInput): ResolvedOutputOptions {
  return resolveOutputOptions(normalizeOutputOptions(input), {
    colorHex: stillStyle.whiteHex,
    brandSweepHex: stillStyle.whiteHex,
    keepMediaIds: [],
  });
}

const input: GeneratePackInput = {
  jobId: "job-variations",
  workspaceId: "ws1",
  tier: "growth",
  channels: ["amazon", "shopify"],
  creditBudget: 200,
  images: [{ mediaId: "m1" }],
  sku: "SKU1",
  seoSlug: "demo-mug",
};

function deps(generator: ShotGenerator): PipelineDeps & { store: InMemoryJobStore } {
  const store = new InMemoryJobStore();
  return {
    ai: makeAi(),
    store,
    clock: systemClock,
    generator,
    delayedRetry: { sleep: async () => {} },
  } as PipelineDeps & { store: InMemoryJobStore };
}

async function reportOf(pack: StoredPack): Promise<PackFileReport[]> {
  return (JSON.parse(await readFile(pack.reportPath, "utf8")) as { files: PackFileReport[] }).files;
}

describe("scene variations in the runner", () => {
  it("makes every version, ships the scene itself and stores the extra versions unpicked", async () => {
    const generator = new CountingGenerator();
    const run = deps(generator);
    const summary = await runGeneratePack({ ...input, output: resolved({ variations: 3 }) }, run);
    expect(summary.error).toBeUndefined();
    expect(summary.state).toBe("done");

    const scenes = generator.calls.filter((c) => c.shot.type === "lifestyle");
    // One call per channel output; one entry per scene.
    const firsts = [...new Map(scenes.filter((c) => c.shot.variation === undefined).map((c) => [c.shot.id, c])).values()];
    expect(firsts.length).toBeGreaterThan(0);
    // Two extra versions per scene, each its own generation of the same scene
    // around the same photo, through the same composite method (rule 3).
    for (const first of firsts) {
      const versions = scenes.filter((c) => parseVariationShotId(c.shot.id)?.baseShotId === first.shot.id);
      expect([...new Set(versions.map((c) => c.shot.variation))].sort()).toEqual([2, 3]);
      for (const version of versions) {
        expect(version.shot.method).toBe(first.shot.method);
        expect(version.shot.sourceMediaId).toBe(first.shot.sourceMediaId);
        expect(version.shot.scene).toBe(first.shot.scene);
      }
    }

    // The pack's own files never include an extra version.
    const pack = summary.pack as StoredPack;
    const files = await reportOf(pack);
    expect(files.some((f) => f.ref !== null && parseVariationShotId(f.ref) !== null)).toBe(false);
    // The extra versions wait in their own batches, one per version number.
    expect(pack.variations?.map((b) => b.variation)).toEqual([2, 3]);
    for (const batch of pack.variations ?? []) {
      expect(batch.files.length).toBeGreaterThan(0);
      for (const file of batch.files) {
        expect(parseVariationShotId(file.ref)?.variation).toBe(batch.variation);
      }
    }

    // Each extra version is charged exactly the seed price, once.
    const charges = run.store.ledger.filter((e) => e.reason === "charge");
    const versionCharges = charges.filter((e) => e.ref !== undefined && parseVariationShotId(e.ref) !== null);
    expect(versionCharges).toHaveLength(firsts.length * 2);
    for (const charge of versionCharges) {
      expect(charge.credits).toBe(creditCosts.generativeStill);
    }
    expect(summary.chargedCredits + summary.releasedCredits).toBe(summary.reservedCredits);
  });

  it("stores no versions and plans today's pack at the default", async () => {
    const generator = new CountingGenerator();
    const summary = await runGeneratePack({ ...input, output: resolved({}) }, deps(generator));
    expect(summary.state).toBe("done");
    expect(summary.pack?.variations).toBeUndefined();
    expect(generator.calls.some((c) => c.shot.variation !== undefined)).toBe(false);
  });

  it("releases an extra version that does not pass and never stores it", async () => {
    const probe = new CountingGenerator();
    await runGeneratePack({ ...input, output: resolved({ variations: 2 }) }, deps(probe));
    const failing = probe.calls.find((c) => c.shot.variation === 2)!.shot.id;

    const run = deps(new CountingGenerator(new Set([failing])));
    const summary = await runGeneratePack({ ...input, output: resolved({ variations: 2 }) }, run);
    expect(summary.state).toBe("done");
    const stored = (summary.pack?.variations ?? []).flatMap((b) => b.files.map((f) => f.ref));
    expect(stored).not.toContain(failing);
    expect(run.store.ledger.filter((e) => e.reason === "charge").map((e) => e.ref)).not.toContain(failing);
    expect(run.store.ledger.find((e) => e.reason === "release" && e.ref === failing)).toMatchObject({
      credits: creditCosts.generativeStill,
    });
  });
});
