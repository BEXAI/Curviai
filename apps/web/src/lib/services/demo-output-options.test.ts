/**
 * Output options in demo mode (docs/phases/PHASE_15.md item 28): the body
 * hash follows the options, the demo plans and holds what production holds
 * for them, previews draw each file in its channel's shape and color, and
 * the demo report reads the packager's treatment notes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import type { Shot } from "@curvi/pipeline/schemas";
import { backgroundSwatches, creditCosts, stillStyle } from "@curvi/pipeline/seed";
import { treatmentNotes } from "@curvi/pipeline/treatment";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { DEMO_PHOTO_SIZE, DemoService, DemoStore, demoShotImage, demoTreatment, hashBody } from "./demo";
import { planDemoShots } from "./demo-plan";
import { outputEstimateInputs } from "./output-options";
import type { CreateJobInput } from "./types";

const FIXED_NOW = () => new Date("2026-09-29T12:00:00.000Z");
const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];

afterEach(() => {
  vi.unstubAllEnvs();
});

function svc(): DemoService {
  return new DemoService(new DemoStore(), FIXED_NOW);
}

async function create(service: DemoService, extra: Partial<CreateJobInput> = {}) {
  const workspace = await service.getCurrentWorkspace();
  const products = await service.listProducts(workspace.id);
  return service.createJob(workspace.id, {
    productId: products[0].id,
    channels: CHANNELS,
    mode: "listing",
    idempotencyKey: "demo-options",
    ...extra,
  });
}

async function finish(service: DemoService, jobId: string) {
  const workspace = await service.getCurrentWorkspace();
  for (let i = 0; i < 40; i++) {
    const job = await service.getJob(workspace.id, jobId);
    if (job?.status === "done") {
      return job;
    }
  }
  throw new Error("the demo pack never finished");
}

function decode(url: string | null | undefined): string {
  return decodeURIComponent((url ?? "").replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
}

const KEEP_SAND = resolveOutputOptions(normalizeOutputOptions({ background: "keep", color: { kind: "swatch", key: "sand" }, fit: "pad" }), {
  colorHex: backgroundSwatches.sand.hex,
  brandSweepHex: stillStyle.fallbackBrandHex,
  keepMediaIds: ["demo_photo_1"],
});

describe("demo body hash", () => {
  const body = { productId: "p1", channels: CHANNELS, mode: "listing" as const };

  it("changes with the options and ignores what the key ignores", () => {
    const plain = hashBody(body);
    expect(hashBody({ ...body, outputOptions: { lookBase: "marketplace", background: "remove" } })).toBe(plain);
    expect(hashBody({ ...body, outputOptions: { background: "keep" } })).not.toBe(plain);
    expect(hashBody({ ...body, outputOptions: { color: { kind: "swatch", key: "sage" } } })).not.toBe(plain);
    expect(hashBody({ ...body, mode: "concept", outputOptions: { background: "keep" } })).toBe(
      hashBody({ ...body, mode: "concept" }),
    );
  });
});

describe("demo packs with output options", () => {
  it("refuses options while the env flag is off, and takes defaults", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "0");
    expect(await svc().outputOptionsEnabled()).toBe(false);
    expect(await create(svc(), { outputOptions: { background: "keep" } })).toMatchObject({
      outcome: "rejected",
      reason: "feature_unavailable",
    });
    expect((await create(svc(), { outputOptions: { lookBase: "marketplace" } })).outcome).toBe("created");
  });

  it("plans and holds a Keep pack exactly as the estimate does, and replays only the same options", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    const service = svc();
    const result = await create(service, { outputOptions: { background: "keep" } });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const types = result.job.shots.map((s) => s.shotType);
    expect(types).toContain("original_photo");
    expect(types).not.toContain("lifestyle");
    expect(types).not.toContain("cutout_png");

    const resolved = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
      colorHex: stillStyle.whiteHex,
      brandSweepHex: "#1D2433",
      keepMediaIds: ["demo_photo_1"],
    });
    const inputs = outputEstimateInputs(resolved, [{ id: "demo_photo_1" }]);
    expect(result.job.creditsReserved).toBe(estimatePackCredits(CHANNELS, "listing", "growth", inputs).total);
    expect(planDemoShots(CHANNELS, "growth", "listing", { output: inputs }).map((s) => s.type)).toEqual(types);
    expect(result.job.outputOptions?.look).toBe("keep_photo");

    const replay = await create(service, { outputOptions: { background: "keep", lookBase: "keep_photo" } });
    expect(replay.outcome).toBe("replayed");
    expect((await create(service, { outputOptions: { background: "keep", fit: "pad" } })).outcome).toBe("conflict");
  });

  it("answers invalid_options for a brand color the demo kit does not have", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    expect(await create(svc(), { outputOptions: { color: { kind: "brand", index: 5 } } })).toMatchObject({
      outcome: "rejected",
      reason: "invalid_options",
    });
  });

  it("emits the treatment notes in the demo report", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    const service = svc();
    const result = await create(service, { outputOptions: { background: "keep", fit: "pad", color: { kind: "swatch", key: "sand" } } });
    if (result.outcome !== "created") throw new Error(result.outcome);
    await finish(service, result.job.id);
    const report = await service.getComplianceReport("demo", result.job.id);
    const files = report?.channels.flatMap((c) => c.files) ?? [];
    const main = files.find((f) => f.specId === "amazon.main");
    expect(main?.notes).toContain("This channel needs a pure white background, so the background was removed for this file only.");
    const kept = files.filter((f) => f.notes.includes("Background kept as you took it.") || f.notes.some((n) => n.startsWith("Resized from")));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0].notes.some((n) => n.startsWith("Resized from 4032 by 3024 pixels."))).toBe(true);
    // A kept photo shared by several channels is one file per channel, so the
    // exact size channel lists its added space.
    const meta = files.find((f) => f.specId === "meta.feed_1x1");
    expect(meta?.notes).toContain(`Space added around your photo in ${backgroundSwatches.sand.hex} to fit this channel's shape.`);
  });
});

describe("demo previews and treatments", () => {
  const original: Shot = {
    id: "s02_original_photo",
    type: "original_photo",
    sourceMediaId: "demo_photo_1",
    method: "deterministic",
    channels: ["meta.feed_4x5"],
    stylePreset: "none",
    credits: creditCosts.deterministic,
    priority: 1,
  };
  const main: Shot = { ...original, id: "s01_amazon_main", type: "amazon_main", channels: ["amazon.main"] };

  it("draws a padded kept photo in the channel's shape with the chosen color, and an auto one in the photo's shape", () => {
    const padded = decode(demoShotImage("original_photo", "meta.feed_4x5", KEEP_SAND));
    expect(padded).toContain('width="320" height="400"');
    expect(padded).toContain(`fill="${backgroundSwatches.sand.hex}"`);
    const auto = decode(demoShotImage("original_photo", "shopify.product", { ...KEEP_SAND, fit: "auto" }));
    expect(auto).toContain('width="400" height="300"');
  });

  it("puts a removed product on the chosen color, and on white where the channel requires it", () => {
    const sage = { ...KEEP_SAND, background: "remove" as const, colorHex: backgroundSwatches.sage.hex };
    expect(decode(demoShotImage("alt_angle_white", "shopify.product", sage))).toContain(`fill="${backgroundSwatches.sage.hex}"`);
    const white = decode(demoShotImage("amazon_main", "amazon.main", sage));
    expect(white).toContain(`fill="${stillStyle.whiteHex}"`);
    expect(white).not.toContain(backgroundSwatches.sage.hex);
  });

  it("records the treatments the packager would", () => {
    const kept = demoTreatment(original, "meta.feed_4x5", KEEP_SAND);
    expect(kept).toMatchObject({
      kind: "original",
      sourceWidth: DEMO_PHOTO_SIZE.width,
      sourceHeight: DEMO_PHOTO_SIZE.height,
      padHex: backgroundSwatches.sand.hex,
    });
    expect(treatmentNotes(kept)).toContain("background: kept at seller request");
    expect(demoTreatment(main, "amazon.main", KEEP_SAND)).toEqual({ kind: "background", forcedWhite: true });
    const sage = { ...KEEP_SAND, background: "remove" as const, colorHex: backgroundSwatches.sage.hex };
    expect(demoTreatment({ ...main, type: "alt_angle_white" }, "shopify.product", sage)).toEqual({
      kind: "background",
      colorHex: backgroundSwatches.sage.hex,
    });
    expect(demoTreatment({ ...main, type: "lifestyle" }, "shopify.product", sage)).toBeNull();
  });
});
