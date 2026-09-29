/**
 * Runtime dependency wiring for the Trigger.dev task wrappers. With zero env
 * vars set, everything here runs against in memory demo implementations: a
 * demo LLM provider answering the seeded recipe tasks with valid fixtures, a
 * demo shot generator that renders spec sized synthetic product images, and
 * in memory stores. Real provider and database wiring activates in the app
 * layer, which passes its own PipelineDeps; these defaults keep every task
 * runnable end to end without credentials.
 */

import { InMemoryCapStore, InMemoryCostMeter, processBreakerStore, ProviderRegistry, SpendCaps } from "@curvi/ai";
import type { CapStore, CostAwareProvider, ProviderRequest, ProviderResponse, RoutingTable } from "@curvi/ai";
import {
  buildProductReferenceFromEncoded,
  encodeJpeg,
  encodePng,
  limitImageMemory,
  makeOriginalFit,
  QC_THRESHOLDS,
  qcKindForSpec,
  solidCanvas,
  type ProductProfile,
  type RawImage,
  type RawMask,
} from "@curvi/pipeline";
import { backgroundFor, MAX_SOURCE_UPSCALE, type ResolvedOutputOptions } from "@curvi/pipeline/output-options";
import { originalFit, recipeSeedRows } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import type { ChurnSignals } from "./churn";
import { cacheCutouts, r2CutoutCacheStore } from "./cutout-cache";
import { LiveShotGenerator, makeR2MediaLoader, wireLiveProviders } from "./live-runtime";
import { canvasSizeFor, encodeForSpec, stillQcErosion } from "./shot-outputs";
import { parseShotConcurrency } from "./shot-concurrency";
import type { DropWorkspace } from "./drops";
import { SpendAlertNotifier } from "./spend-alerts";
import { processQuotaNotifier, type QuotaEventWriter } from "./provider-quota";
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
export class DemoLlmProvider implements CostAwareProvider {
  readonly name = "demo-llm";
  readonly kind = "llm" as const;
  private readonly tasks = recipeSeedRows.filter((r) => r.active).map((r) => r.key);

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /** Demo calls are free; the estimate keeps the caps machinery exercised. */
  estimateCostMicros(): number {
    return 0;
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

/** Size of the demo generator's synthetic kept photo: a 4:3 phone shot. */
const DEMO_PHOTO_SIZE = { width: 1600, height: 1200 } as const;

/**
 * Renders a synthetic product image sized to the shot's channel spec: a pure
 * white canvas with a centered product rectangle and a matching mask, so the
 * deterministic QC checks pass honestly. Composite methods also get a
 * product reference canvas for the fidelity report. Generations are
 * memoized per spec and method class, the content is deterministic.
 */
export class DemoShotGenerator implements ShotGenerator {
  private readonly cache = new Map<string, Promise<ShotGeneration>>();
  private photo: Promise<Buffer> | null = null;

  generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    const specId = args.shot.channels[0];
    if (args.shot.type === "original_photo") {
      // A kept photo in db mode without providers: a patterned synthetic
      // photo fitted with the real geometry (PHASE_15 item 22).
      const key = `${specId}:original:${args.output?.fit ?? "auto"}:${args.output?.colorHex ?? ""}`;
      let cached = this.cache.get(key);
      if (!cached) {
        cached = this.renderOriginal(specId, args.output);
        this.cache.set(key, cached);
      }
      return cached;
    }
    const needsReference = args.shot.method === "composite_generate" || args.shot.method === "edit_generate";
    const key = `${specId}:${needsReference ? "ref" : "plain"}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = this.render(specId, needsReference);
      this.cache.set(key, cached);
    }
    return cached;
  }

  /** A synthetic photo with a pattern, so resizing and added space show. */
  private demoPhoto(): Promise<Buffer> {
    this.photo ??= (async () => {
      const { width, height } = DEMO_PHOTO_SIZE;
      const image = solidCanvas(width, height, 0, 0, 0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const o = (y * width + x) * 4;
          const band = (Math.floor(x / 80) + Math.floor(y / 80)) % 2;
          image.data[o] = 90 + Math.round((120 * x) / width);
          image.data[o + 1] = band ? 150 : 110;
          image.data[o + 2] = 90 + Math.round((120 * y) / height);
        }
      }
      return encodeJpeg(image, 92);
    })();
    return this.photo;
  }

  private async renderOriginal(specId: string, output: ResolvedOutputOptions | undefined): Promise<ShotGeneration> {
    const spec = getSpec(specId);
    const photo = await this.demoPhoto();
    const fitted = await makeOriginalFit(photo, spec, {
      fit: output?.fit ?? "auto",
      padRgb: backgroundFor(spec, output).rgb,
      maxUpscale: MAX_SOURCE_UPSCALE,
      maxMegapixels: originalFit.maxMegapixels,
    });
    if (fitted.passthrough) {
      return {
        image: { data: Buffer.alloc(0), width: fitted.width, height: fitted.height, channels: 4 },
        mask: null,
        encoded: { buffer: fitted.passthrough.bytes, format: fitted.passthrough.format },
        costMicros: 0,
        fidelityKind: "main",
        treatment: fitted.treatment,
        passthrough: { sha256: fitted.passthrough.sha256 },
      };
    }
    const reference = await buildProductReferenceFromEncoded(photo, fitted.placement, {
      width: fitted.width,
      height: fitted.height,
    });
    const erosion = await stillQcErosion(fitted.mask, fitted.treatment.scale ?? 1);
    const out = await encodeForSpec(fitted.raw, fitted.mask, reference, spec, {
      preferPng: fitted.preferPng,
      erodePx: erosion.erodePx,
      fidelityKind: "main",
    });
    return {
      image: out.image,
      mask: fitted.mask,
      productReference: reference,
      encoded: out.encoded,
      costMicros: 0,
      fidelityRequired: true,
      fidelityKind: "main",
      fidelityErodePx: erosion.erodePx,
      fidelityErodeFloorPx: erosion.floorPx,
      treatment: fitted.treatment,
    };
  }

  private async render(specId: string, needsReference: boolean): Promise<ShotGeneration> {
    const spec = getSpec(specId);
    const { width, height } = canvasSizeFor(spec);
    const longest = Math.max(width, height);
    // A main class spec without its own fill rule (walmart.main) is checked
    // against the main image fill band, so the demo render sits inside it.
    const fill =
      spec.fill ??
      (qcKindForSpec(spec) === "main"
        ? { min: QC_THRESHOLDS.main.fillMin, max: QC_THRESHOLDS.main.fillMax }
        : null);
    const fillFraction = fill ? (fill.min + fill.max) / 2 : 0.6;
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
  /** Shared running totals for the spend caps. Without one the caps count
   * per process only, which is fine for demo mode and tests but not for
   * production, where every task run builds fresh deps. */
  capStore?: CapStore;
  /** True when the run settles real customer credits (the db backed store).
   * The demo generator is then never used, even with no provider keys:
   * charging for synthetic placeholders is never acceptable. Local db
   * development can opt back in with CURVI_ALLOW_DEMO_GENERATION=1. */
  realCredits?: boolean;
  /** Founder notice when global daily provider spend passes the alert line.
   * Wired both as the runner's onSpendAlert and as every routed provider
   * call's onCapAlert (Update.md 5.7). Defaults to a process wide founder
   * notifier without a database (email when Resend is configured, otherwise
   * a structured log line), once per day. */
  onSpendAlert?: (totalMicros: number) => void;
  /** Where provider_quota_exhausted events rows go (the db runtime); logs
   * only without one. */
  quotaEventDb?: QuotaEventWriter;
}

const runtimeScope = globalThis as typeof globalThis & { __curviRuntimeSpendAlerts?: SpendAlertNotifier };

/** The founder spend alert for runs without a database: one notifier per
 * process, so its once per day dedupe spans every pack. */
export function defaultSpendAlert(): (totalMicros: number) => void {
  runtimeScope.__curviRuntimeSpendAlerts ??= new SpendAlertNotifier();
  return runtimeScope.__curviRuntimeSpendAlerts.onSpendAlert;
}

/**
 * Receives the bookkeeping errors the router swallows so they can never turn
 * a paid call into a retry or a double release (meter, breaker, reservation
 * release, alert delivery). A structured error line log search and alerting
 * can match; error reporting (Sentry) hooks in here once its SDK is wired.
 */
export function reportAiInternalError(err: unknown, context: string): void {
  console.error(
    JSON.stringify({
      level: "error",
      event: "ai_internal_error",
      context,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/** Demo mode notice shown by task wrappers when no provider env is set. */
export const DEMO_MODE_NOTICE =
  "Running in demo mode with in memory providers. Set provider API keys and database env to run against real services.";

export function buildRuntimeDeps(opts: RuntimeDepsOptions = {}): PipelineDeps {
  const registry = new ProviderRegistry();
  registry.register(new DemoLlmProvider());
  // The founder raises the $150 global hard stop through this env var
  // (plan 4.4). The other cap amounts are platform constants in @curvi/ai.
  const hardStopUsd = Number(optionalEnv("DAILY_SPEND_HARD_STOP_USD") ?? "");
  const caps = new SpendCaps(opts.capStore ?? new InMemoryCapStore(), () => new Date(), {
    globalDailyHardStopMicros:
      Number.isFinite(hardStopUsd) && hardStopUsd > 0 ? Math.round(hardStopUsd * 1_000_000) : undefined,
  });
  const routing = demoRoutingTable();
  const onSpendAlert = opts.onSpendAlert ?? defaultSpendAlert();
  const ai: PipelineDeps["ai"] = {
    registry,
    routing,
    meter: new InMemoryCostMeter(),
    // Shared by every pack run in this process, so a provider that is
    // failing or out of quota is skipped by the next pack too, and the web
    // health endpoint and new pack preflight read the same state.
    breakerStore: processBreakerStore(),
    caps,
    onCapAlert: onSpendAlert,
    onInternalError: reportAiInternalError,
    onProviderQuota: processQuotaNotifier(opts.quotaEventDb).onProviderQuota,
  };
  const wiring = wireLiveProviders(registry, routing);
  // Cutouts are cached in R2 per workspace and exact input bytes, so the pack
  // reuses the cutout its preflight at upload paid for (PHASE_14.md W4). The
  // one store wraps the cutout providers and is read directly by the live
  // generator (PHASE_15 item 16).
  const cutoutCache = r2CutoutCacheStore();
  if (cutoutCache) {
    cacheCutouts(registry, cutoutCache);
  }
  const loadMedia = makeR2MediaLoader();
  // Any live provider key means real customers and real spend, so the demo
  // generator (synthetic placeholder images built to pass QC) must never run.
  // Shots the live path cannot produce go to needs review with no charge.
  // A db backed run settles real credits, so it never uses the demo generator
  // either: with no keys the live generator marks every shot unavailable.
  limitImageMemory();
  const liveMode = wiring.llmLive || wiring.imageProviders.length > 0 || wiring.cutoutLive;
  const demoAllowed = !opts.realCredits || optionalEnv("CURVI_ALLOW_DEMO_GENERATION") === "1";
  const generator =
    liveMode || !demoAllowed ? new LiveShotGenerator({ ai, wiring, loadMedia, cutoutCache }) : new DemoShotGenerator();
  return {
    ai,
    store: new InMemoryJobStore(),
    clock: systemClock,
    generator,
    loadMedia: loadMedia ?? undefined,
    packOutDir: opts.packOutDir,
    onSpendAlert,
    ...shotConcurrencyFromEnv(),
  };
}

/** CURVI_SHOT_CONCURRENCY (1 to 8) when set to a whole number; the runner's
 * default otherwise. */
function shotConcurrencyFromEnv(): { shotConcurrency?: number } {
  const shotConcurrency = parseShotConcurrency(optionalEnv("CURVI_SHOT_CONCURRENCY"));
  return shotConcurrency === undefined ? {} : { shotConcurrency };
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
