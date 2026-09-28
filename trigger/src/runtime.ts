/**
 * Runtime dependency wiring for the Trigger.dev task wrappers. With zero env
 * vars set, everything here runs against in memory demo implementations: a
 * demo LLM provider answering the seeded recipe tasks with valid fixtures, a
 * demo shot generator that renders spec sized synthetic product images, and
 * in memory stores. Real provider and database wiring activates in the app
 * layer, which passes its own PipelineDeps; these defaults keep every task
 * runnable end to end without credentials.
 */

import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry } from "@curvi/ai";
import type { Provider, ProviderRequest, ProviderResponse, RoutingTable } from "@curvi/ai";
import {
  encodeJpeg,
  encodePng,
  solidCanvas,
  type ProductProfile,
  type RawImage,
  type RawMask,
} from "@curvi/pipeline";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import type { ChurnSignals } from "./churn";
import { LiveShotGenerator, makeR2MediaLoader, wireLiveProviders } from "./live-runtime";
import type { DropWorkspace } from "./drops";
import {
  activeRecipe,
  InMemoryJobStore,
  systemClock,
  type PipelineDeps,
  type ShotGenerateArgs,
  type ShotGeneration,
  type ShotGenerator,
} from "./pipeline-runner";

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Demo product profile satisfying the ProductProfile schema. */
export const demoProfile: ProductProfile = {
  productCount: 1,
  category: "home_kitchen",
  amazonProductTypeGuess: "DRINKING_CUP",
  shopifyTaxonomyGuess: "Home & Garden > Kitchen & Dining > Tableware > Drinkware",
  name: "Demo ceramic mug",
  formFactor: "cylindrical mug with handle",
  materials: ["ceramic"],
  dominantColors: [{ name: "slate blue", hex: "#64708C", coveragePct: 62 }],
  dimensions: null,
  preserveText: [],
  preserveLogos: [],
  surface: { reflective: false, transparent: false, textured: false },
  features: ["12 ounce capacity", "dishwasher safe"],
  benefits: ["keeps drinks warm", "easy grip handle", "fits cup holders"],
  targetBuyer: "home coffee drinkers",
  useContexts: ["kitchen counter", "office desk"],
  photographedAngles: ["front", "45", "side"],
  missingAnglesNeeded: ["back"],
  complianceFlags: ["none"],
  imageQuality: { usableForMain: true, issues: [] },
};

/**
 * Demo LLM provider answering every seeded recipe task with a fixture. The
 * shot planner answer is intentionally not a valid ShotList so the pipeline
 * exercises its deterministic planner fallback in demo mode.
 */
export class DemoLlmProvider implements Provider {
  readonly name = "demo-llm";
  readonly kind = "llm" as const;
  private readonly tasks = recipeSeedRows.filter((r) => r.active).map((r) => r.key);

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    return { output: this.fixtureFor(req.task) as TOut, costMicros: 0 };
  }

  private fixtureFor(task: string): unknown {
    if (task === activeRecipe("intake").key) {
      return {
        images: [
          {
            sellableProduct: true,
            distinctProducts: 1,
            sharpEnough: true,
            flags: {
              nudity: false,
              weapons: false,
              drugs: false,
              prohibited: false,
              realPersonMainSubject: false,
            },
          },
        ],
      };
    }
    if (task === activeRecipe("analyze").key) {
      return demoProfile;
    }
    if (task === activeRecipe("plan").key) {
      return { note: "Demo planner defers to the deterministic shot planner." };
    }
    if (task === activeRecipe("qc").key) {
      return { pass: true, fidelity: 0.96, issues: [], repairHint: "" };
    }
    return { note: `No demo fixture for task ${task}` };
  }
}

/** Routing table mapping every active recipe task to the demo LLM provider. */
export function demoRoutingTable(): RoutingTable {
  const routing: RoutingTable = {};
  for (const recipe of recipeSeedRows) {
    if (recipe.active) {
      routing[recipe.key] = ["demo-llm"];
    }
  }
  return routing;
}

/**
 * Renders a synthetic product image sized to the shot's channel spec: a pure
 * white canvas with a centered product rectangle and a matching mask, so the
 * deterministic QC checks pass honestly. Composite methods also get a
 * product reference canvas for the fidelity report. Generations are
 * memoized per spec and method class, the content is deterministic.
 */
export class DemoShotGenerator implements ShotGenerator {
  private readonly cache = new Map<string, Promise<ShotGeneration>>();

  generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    const specId = args.shot.channels[0];
    const needsReference = args.shot.method === "composite_generate" || args.shot.method === "edit_generate";
    const key = `${specId}:${needsReference ? "ref" : "plain"}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.render(specId, needsReference);
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async render(specId: string, needsReference: boolean): Promise<ShotGeneration> {
    const spec = getSpec(specId);
    const width = spec.width ?? spec.minWidth ?? 1200;
    const height = spec.height ?? spec.minHeight ?? width;
    const longest = Math.max(width, height);
    const fillFraction = spec.fill ? (spec.fill.min + spec.fill.max) / 2 : 0.6;
    const rectLong = Math.round(fillFraction * longest);
    const rectW = Math.min(rectLong, Math.floor(width * 0.92));
    const rectH = Math.min(rectLong, Math.floor(height * 0.92));
    const left = Math.floor((width - rectW) / 2);
    const top = Math.floor((height - rectH) / 2);

    const image = solidCanvas(width, height, 255, 255, 255);
    const maskData = Buffer.alloc(width * height, 0);
    const reference: RawImage | undefined = needsReference
      ? { data: Buffer.alloc(width * height * 4, 0), width, height, channels: 4 }
      : undefined;
    for (let y = top; y < top + rectH; y++) {
      for (let x = left; x < left + rectW; x++) {
        const idx = y * width + x;
        const o = idx * 4;
        image.data[o] = 100;
        image.data[o + 1] = 110;
        image.data[o + 2] = 140;
        image.data[o + 3] = 255;
        maskData[idx] = 255;
        if (reference) {
          reference.data[o] = 100;
          reference.data[o + 1] = 110;
          reference.data[o + 2] = 140;
          reference.data[o + 3] = 255;
        }
      }
    }
    const mask: RawMask = { data: maskData, width, height };

    const formats = (spec.formats ?? ["png"]) as readonly string[];
    const usePng = formats.includes("png") || !formats.includes("jpg");
    const buffer = usePng ? await encodePng(image) : await encodeJpeg(image);
    return {
      image,
      mask,
      productReference: reference,
      encoded: { buffer, format: usePng ? "png" : "jpg" },
      costMicros: 0,
    };
  }
}

export interface RuntimeDepsOptions {
  packOutDir?: string;
}

/** Demo mode notice shown by task wrappers when no provider env is set. */
export const DEMO_MODE_NOTICE =
  "Running in demo mode with in memory providers. Set provider API keys and database env to run against real services.";

export function buildRuntimeDeps(opts: RuntimeDepsOptions = {}): PipelineDeps {
  const registry = new ProviderRegistry();
  registry.register(new DemoLlmProvider());
  const routing = demoRoutingTable();
  const ai: PipelineDeps["ai"] = {
    registry,
    routing,
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
  const wiring = wireLiveProviders(registry, routing);
  const demoGenerator = new DemoShotGenerator();
  const loadMedia = makeR2MediaLoader();
  const generator =
    wiring.imageProviders.length > 0 && wiring.cutoutLive && loadMedia
      ? new LiveShotGenerator({ ai, wiring, loadMedia, fallback: demoGenerator })
      : demoGenerator;
  return {
    ai,
    store: new InMemoryJobStore(),
    clock: systemClock,
    generator,
    packOutDir: opts.packOutDir,
  };
}

/** Demo workspaces for the weekly drop cron in envless mode. */
export function demoDropWorkspaces(): DropWorkspace[] {
  return [
    {
      id: "demo-workspace",
      tier: "growth",
      active: true,
      products: [
        {
          id: "demo-mug",
          name: "Demo ceramic mug",
          performanceScore: 92,
          useContexts: ["kitchen counter", "office desk"],
        },
        {
          id: "demo-bottle",
          name: "Demo water bottle",
          performanceScore: 81,
          useContexts: ["gym bag", "hiking trail"],
        },
        {
          id: "demo-board",
          name: "Demo serving board",
          performanceScore: 74,
          useContexts: ["dinner table"],
        },
        {
          id: "demo-coaster",
          name: "Demo coaster set",
          performanceScore: 33,
          useContexts: ["coffee table"],
        },
      ],
    },
  ];
}

/** Demo churn signals for the daily churn scoring cron in envless mode. */
export function demoChurnSignals(): Array<{ workspaceId: string; signals: ChurnSignals }> {
  return [
    {
      workspaceId: "demo-healthy",
      signals: {
        daysSinceLastLogin: 1,
        pastMidCycle: true,
        creditsUsedShare: 0.6,
        avgRejectedAssetsPerPack: 0,
        paymentFailed: false,
        visitedCancelOrBillingPage: false,
        hasShopifyConnection: true,
      },
    },
    {
      workspaceId: "demo-watch",
      signals: {
        daysSinceLastLogin: 12,
        pastMidCycle: true,
        creditsUsedShare: 0.5,
        avgRejectedAssetsPerPack: 2,
        paymentFailed: false,
        visitedCancelOrBillingPage: false,
        hasShopifyConnection: true,
      },
    },
    {
      workspaceId: "demo-at-risk",
      signals: {
        daysSinceLastLogin: 15,
        pastMidCycle: true,
        creditsUsedShare: 0.1,
        avgRejectedAssetsPerPack: 3,
        paymentFailed: true,
        visitedCancelOrBillingPage: true,
        hasShopifyConnection: false,
      },
    },
  ];
}
