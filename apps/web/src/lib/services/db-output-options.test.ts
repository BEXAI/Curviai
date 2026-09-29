/**
 * Seller output options through DbService against the real migrations in
 * PGlite (docs/phases/PHASE_15.md items 24 to 26): createJob resolves,
 * snapshots and stores the options, refuses what the flags, the plan or the
 * kit cannot honor, holds what the options plan, and replays only the same
 * choices; follow ups read the stored options, never the live kit; the
 * upload path records source_media.ingest.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import {
  assets,
  brandKits,
  creditLedger,
  generationJobs,
  jobSteps,
  members,
  packFiles,
  platformSettings,
  products,
  signupGrants,
  sourceMedia,
  uploadPreflights,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db, type SourceMediaAngle } from "@curvi/db";
import { backgroundSwatches, creditCosts, stillStyle } from "@curvi/pipeline/seed";
import type { Shot } from "@curvi/pipeline/schemas";
import type { GeneratePackPayload } from "@/lib/jobs/payload";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { PACKS_PAUSED_COPY } from "@/lib/provider-preflight";
import { resetOutputOptionsSwitchForTests } from "@/lib/features";
import type { IngestOutcome } from "@/lib/trust/ingest";
import { DbService, ingestRecordOf, mergeIngestRecords } from "./db";
import {
  BRAND_COLOR_MISSING_MESSAGE,
  BRAND_COLOR_UPGRADE_MESSAGE,
  OPTIONS_UNAVAILABLE_MESSAGE,
  outputEstimateInputs,
} from "./output-options";
import type { CreateJobInput } from "./types";

const queue = vi.hoisted(() => ({
  pack: vi.fn<(payload: unknown) => Promise<"inline">>(async () => "inline"),
  followUp: vi.fn<(payload: PackFollowUpInput) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueueGeneratePack: queue.pack,
  enqueuePackFollowUp: queue.followUp,
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f501";
const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
const KEEP = { background: "keep" as const };
let keyCounter = 0;

interface ServiceOptions {
  enabled?: boolean | null;
  verdict?: "ok" | "packs_paused" | "scenes_paused";
  ingest?: (key: string) => IngestOutcome;
}

/** A service with the options gate on unless told otherwise; null leaves the
 * real gate (env flag and kill switch) in charge. */
function service(opts: ServiceOptions = {}): DbService {
  const enabled = opts.enabled === undefined ? true : opts.enabled;
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => OWNER,
    getSupabase: async () => null,
    ...(enabled === null ? {} : { outputOptionsEnabled: async () => enabled }),
    providerVerdict: async () => opts.verdict ?? "ok",
    ...(opts.ingest ? { ingestUpload: async (key: string) => opts.ingest!(key) } : {}),
  });
}

async function workspaceWith(
  plan: string,
  opts: { credits?: number; kit?: string[]; photos?: Array<{ name: string; angle?: SourceMediaAngle; width?: number; height?: number }> } = {},
): Promise<{ ws: string; productId: string; keys: string[] }> {
  const [w] = await db.insert(workspaces).values({ name: `${plan} ws`, plan }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  const photos = opts.photos ?? [{ name: "front.jpg", angle: "front" as const, width: 3000, height: 3000 }];
  const keys: string[] = [];
  for (const photo of photos) {
    const key = `ws/${w.id}/src/${photo.name}`;
    keys.push(key);
    await db.insert(sourceMedia).values({
      workspaceId: w.id,
      productId: p.id,
      r2Key: key,
      kind: "image",
      sha256: "a".repeat(64),
      angle: photo.angle ?? null,
      width: photo.width ?? null,
      height: photo.height ?? null,
    });
  }
  if (opts.kit) {
    await db.insert(brandKits).values({ workspaceId: w.id, colors: opts.kit });
  }
  await db
    .insert(creditLedger)
    .values({ workspaceId: w.id, delta: opts.credits ?? 100, reason: "grant", source: "system" });
  return { ws: w.id, productId: p.id, keys };
}

function jobInput(productId: string, extra: Partial<CreateJobInput> = {}): CreateJobInput {
  keyCounter += 1;
  return { productId, channels: CHANNELS, mode: "listing", idempotencyKey: `options-${keyCounter}`, ...extra };
}

async function jobRow(jobId: string) {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row;
}

function lastPayload(): GeneratePackPayload {
  return queue.pack.mock.calls.at(-1)?.[0] as GeneratePackPayload;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  queue.pack.mockReset();
  queue.pack.mockResolvedValue("inline");
  queue.followUp.mockReset();
  queue.followUp.mockResolvedValue("inline");
  resetOutputOptionsSwitchForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("DbService.createJob with output options", () => {
  it("stores the resolved options with the brand hex snapshotted and sends them to the runner", async () => {
    const { ws, productId, keys } = await workspaceWith("growth", { kit: ["#1f2a44", "#FD7F11"] });
    const result = await service().createJob(
      ws,
      jobInput(productId, { outputOptions: { color: { kind: "brand", index: 0 } } }),
    );
    expect(result.outcome).toBe("created");
    const jobId = result.outcome === "created" ? result.job.id : "";
    const row = await jobRow(jobId);
    expect(row.outputOptions).toMatchObject({
      v: 1,
      look: "brand",
      background: "remove",
      color: { kind: "brand", index: 0 },
      colorHex: "#1F2A44",
      brandSweepHex: "#1F2A44",
      keepMediaIds: [],
    });
    const payload = lastPayload();
    expect(payload.output).toEqual(row.outputOptions);
    expect(payload.images[0]).toMatchObject({ mediaId: keys[0], width: 3000, height: 3000 });
    expect(result.outcome === "created" ? result.job.outputOptions?.look : null).toBe("brand");
  });

  it("stores today's pack when no options are sent, and replays explicit defaults as the same body", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const input = jobInput(productId);
    const first = await service().createJob(ws, input);
    expect(first.outcome).toBe("created");
    const row = await jobRow(first.outcome === "created" ? first.job.id : "");
    expect(row.outputOptions).toMatchObject({ look: "marketplace", colorHex: stillStyle.whiteHex, keepMediaIds: [] });

    const explicit = await service().createJob(ws, {
      ...input,
      outputOptions: { v: 1, background: "remove", color: { kind: "swatch", key: "white" }, fit: "auto", lookBase: "marketplace" },
    });
    expect(explicit.outcome).toBe("replayed");
  });

  it("replays the same options and answers a conflict for different options under the same key", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const input = jobInput(productId, { outputOptions: { background: "keep" } });
    expect((await service().createJob(ws, input)).outcome).toBe("created");
    // Same choices, keys in another order and the look base changed.
    expect(
      (await service().createJob(ws, { ...input, outputOptions: { lookBase: "keep_photo", background: "keep", fit: "auto" } }))
        .outcome,
    ).toBe("replayed");
    const other = await service().createJob(ws, { ...input, outputOptions: { background: "keep", fit: "pad" } });
    expect(other.outcome).toBe("conflict");
    const none = await service().createJob(ws, { ...input, outputOptions: undefined });
    expect(none.outcome).toBe("conflict");
  });

  it("answers a conflict when only a photo's own background differs under the same key", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const side = { key: `ws/${ws}/src/side.jpg`, sha256: "c".repeat(64), kind: "image" as const };
    const svc = service({
      ingest: () => ({
        ok: true,
        sha256: "c".repeat(64),
        width: 2000,
        height: 2000,
        bytes: 10,
        rewritten: false,
        ingest: { v: 1, reencoded: false, sourceFormat: "jpeg" },
      }),
    });
    const input = jobInput(productId, { uploads: [{ ...side, background: "keep" }] });
    const first = await svc.createJob(ws, input);
    expect(first.outcome).toBe("created");
    expect((await jobRow(first.outcome === "created" ? first.job.id : "")).outputOptions).toMatchObject({
      background: "remove",
      keepMediaIds: [side.key],
    });
    expect((await svc.createJob(ws, input)).outcome).toBe("replayed");
    expect((await svc.createJob(ws, { ...input, uploads: [side] })).outcome).toBe("conflict");
    expect((await svc.createJob(ws, { ...input, uploads: [{ ...side, background: "remove" }] })).outcome).toBe("conflict");
  });

  it("replays a pack setting upload as the pack, and a kept upload only as itself (P1)", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const upload = { key: `ws/${ws}/src/new.jpg`, sha256: "c".repeat(64), kind: "image" as const, angle: "back" as const };
    const input = jobInput(productId, { uploads: [upload] });
    expect((await service().createJob(ws, input)).outcome).toBe("created");
    expect((await service().createJob(ws, { ...input, uploads: [{ ...upload, background: "pack" }] })).outcome).toBe(
      "replayed",
    );
    const kept = await service().createJob(ws, { ...input, uploads: [{ ...upload, background: "keep" }] });
    expect(kept.outcome).toBe("conflict");

    const keptInput = jobInput(productId, { uploads: [{ ...upload, key: `ws/${ws}/src/kept.jpg`, background: "keep" }] });
    expect((await service().createJob(ws, keptInput)).outcome).toBe("created");
    expect((await service().createJob(ws, keptInput)).outcome).toBe("replayed");
    const removed = await service().createJob(ws, { ...keptInput, uploads: [{ ...keptInput.uploads![0], background: "pack" }] });
    expect(removed.outcome).toBe("conflict");
  });

  it("answers invalid_options for a brand color the kit does not have", async () => {
    const { ws, productId } = await workspaceWith("starter", { kit: ["#112233"] });
    const result = await service().createJob(ws, jobInput(productId, { outputOptions: { color: { kind: "brand", index: 3 } } }));
    expect(result).toEqual({ outcome: "rejected", reason: "invalid_options", message: BRAND_COLOR_MISSING_MESSAGE });
    expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws))).toHaveLength(0);
  });

  it("answers upgrade_required for a brand color on a plan without brand kits", async () => {
    const { ws, productId } = await workspaceWith("free", { kit: ["#112233"] });
    const result = await service().createJob(ws, jobInput(productId, { outputOptions: { color: { kind: "brand", index: 0 } } }));
    expect(result).toEqual({ outcome: "rejected", reason: "upgrade_required", message: BRAND_COLOR_UPGRADE_MESSAGE });
  });

  it("answers feature_unavailable for options other than today's pack while the gate is off, and still takes defaults", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const refused = await service({ enabled: false }).createJob(ws, jobInput(productId, { outputOptions: KEEP }));
    expect(refused).toEqual({ outcome: "rejected", reason: "feature_unavailable", message: OPTIONS_UNAVAILABLE_MESSAGE });
    const defaults = await service({ enabled: false }).createJob(
      ws,
      jobInput(productId, { outputOptions: { lookBase: "marketplace", background: "remove" } }),
    );
    expect(defaults.outcome).toBe("created");
  });

  it("reads the env flag and the platform_settings kill switch, failing closed without the row", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const live = service({ enabled: null });
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "0");
    expect(await live.outputOptionsEnabled()).toBe(false);
    expect(await live.createJob(ws, jobInput(productId, { outputOptions: KEEP }))).toMatchObject({
      reason: "feature_unavailable",
    });

    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    resetOutputOptionsSwitchForTests();
    expect(await live.outputOptionsEnabled()).toBe(false);

    await db
      .insert(platformSettings)
      .values({ key: "output_options_enabled", value: false })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: false } });
    resetOutputOptionsSwitchForTests();
    expect(await live.createJob(ws, jobInput(productId, { outputOptions: KEEP }))).toMatchObject({
      reason: "feature_unavailable",
    });

    await db.update(platformSettings).set({ value: true }).where(eq(platformSettings.key, "output_options_enabled"));
    resetOutputOptionsSwitchForTests();
    expect((await live.createJob(ws, jobInput(productId, { outputOptions: KEEP }))).outcome).toBe("created");
    await db.delete(platformSettings).where(eq(platformSettings.key, "output_options_enabled"));
  });

  it("holds what the options plan, keeps the merged photos by R2 key and sends their sizes", async () => {
    const photos = [
      { name: "front.jpg", angle: "front" as const, width: 4032, height: 3024 },
      { name: "back.jpg", angle: "back" as const, width: 3000, height: 2000 },
    ];
    const { ws, productId, keys } = await workspaceWith("starter", { photos });
    const result = await service().createJob(ws, jobInput(productId, { outputOptions: KEEP }));
    expect(result.outcome).toBe("created");
    const row = await jobRow(result.outcome === "created" ? result.job.id : "");
    const stored = row.outputOptions as { keepMediaIds: string[] };
    expect([...stored.keepMediaIds].sort()).toEqual([...keys].sort());

    const expected = estimatePackCredits(CHANNELS, "listing", "starter", {
      angles: ["back", "front"],
      hasBoxContents: false,
      hasComparisonFacts: false,
      ...outputEstimateInputs(row.outputOptions as never, [
        { id: keys[1], angle: "back", width: 3000, height: 2000 },
        { id: keys[0], angle: "front", width: 4032, height: 3024 },
      ]),
    }).total;
    expect(row.creditsReserved).toBe(expected);
    const today = estimatePackCredits(CHANNELS, "listing", "starter", { angles: ["back", "front"] }).total;
    expect(row.creditsReserved).toBeLessThan(today);

    const payload = lastPayload();
    expect(payload.output?.background).toBe("keep");
    expect(payload.images.map((image) => [image.mediaId, image.width, image.height])).toEqual([
      [keys[0], 4032, 3024],
      [keys[1], 3000, 2000],
    ]);
  });

  it("refuses a pack that needs a cutout while cutouts are paused, and runs a Keep pack that needs none", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const paused = service({ verdict: "packs_paused" });
    expect(await paused.createJob(ws, jobInput(productId))).toEqual({
      outcome: "rejected",
      reason: "unavailable",
      message: PACKS_PAUSED_COPY,
    });
    const keepOnly = await paused.createJob(
      ws,
      jobInput(productId, { channels: ["shopify.product", "etsy.listing"], outputOptions: KEEP }),
    );
    expect(keepOnly.outcome).toBe("created");
  });

  it("records source_media.ingest for uploads, keeping a re-encode the preflight saw first", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const rotated = `ws/${ws}/src/rotated.jpg`;
    const plain = `ws/${ws}/src/plain.png`;
    // The preflight at upload turned the rotated photo upright.
    await db.insert(uploadPreflights).values({
      workspaceId: ws,
      r2Key: rotated,
      noteKey: "",
      status: "ready",
      result: { status: "ready", ingest: { v: 1, reencoded: true, sourceFormat: "jpeg" } },
    });
    const svc = service({
      ingest: (key) => ({
        ok: true,
        sha256: "c".repeat(64),
        width: 2000,
        height: 1500,
        bytes: 10,
        rewritten: false,
        ingest: { v: 1, reencoded: false, sourceFormat: key.endsWith(".png") ? "png" : "jpeg" },
      }),
    });
    const result = await svc.createJob(
      ws,
      jobInput(productId, {
        outputOptions: KEEP,
        uploads: [
          { key: rotated, sha256: "c".repeat(64), kind: "image", angle: "front" },
          { key: plain, sha256: "d".repeat(64), kind: "image", angle: "back" },
        ],
      }),
    );
    expect(result.outcome).toBe("created");
    const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, ws));
    const byKey = new Map(rows.map((r) => [r.r2Key, r]));
    expect(byKey.get(rotated)?.ingest).toEqual({ v: 1, reencoded: true, sourceFormat: "jpeg" });
    expect(byKey.get(plain)?.ingest).toEqual({ v: 1, reencoded: false, sourceFormat: "png" });
    const payload = lastPayload();
    expect(payload.images.find((i) => i.mediaId === rotated)?.reencoded).toBe(true);
    expect(payload.images.find((i) => i.mediaId === plain)?.reencoded).toBe(false);
  });

  it("registers an upload with its ingest record", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const key = `ws/${ws}/src/registered.gif`;
    const svc = service({
      ingest: () => ({
        ok: true,
        sha256: "e".repeat(64),
        width: 800,
        height: 600,
        bytes: 10,
        rewritten: true,
        ingest: { v: 1, reencoded: true, sourceFormat: "gif" },
      }),
    });
    expect((await svc.registerSourceMedia(ws, { productId, r2Key: key, kind: "image", bytes: 10, sha256: "e".repeat(64) })).ok).toBe(true);
    const [row] = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key));
    expect(row.ingest).toEqual({ v: 1, reencoded: true, sourceFormat: "gif" });
  });
});

describe("ingest records", () => {
  it("reads only well formed records and keeps the first re-encode", () => {
    expect(ingestRecordOf(null)).toBeNull();
    expect(ingestRecordOf({ v: 2, reencoded: true, sourceFormat: "jpeg" })).toBeNull();
    expect(ingestRecordOf({ v: 1, reencoded: "yes", sourceFormat: "jpeg" })).toBeNull();
    const upright = { v: 1 as const, reencoded: true, sourceFormat: "jpeg" as const };
    const later = { v: 1 as const, reencoded: false, sourceFormat: "jpeg" as const };
    expect(mergeIngestRecords(upright, later)).toBe(upright);
    expect(mergeIngestRecords(null, later)).toBe(later);
    expect(mergeIngestRecords(later, null)).toBe(later);
  });
});

describe("DbService.listProducts and getJob", () => {
  it("counts each product's stored photos, capped at the pack limit", async () => {
    const photos = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}.jpg` }));
    const { ws, productId } = await workspaceWith("starter", { photos });
    const [empty] = await db.insert(products).values({ workspaceId: ws, title: "Empty", mode: "listing" }).returning();
    const listed = await service().listProducts(ws);
    expect(listed.find((p) => p.id === productId)?.storedPhotoCount).toBe(6);
    expect(listed.find((p) => p.id === empty.id)?.storedPhotoCount).toBe(0);
  });

  it("shows the Your choices card, and none for options it cannot read", async () => {
    const { ws, productId, keys } = await workspaceWith("starter");
    const created = await service().createJob(ws, jobInput(productId, { outputOptions: KEEP }));
    const jobId = created.outcome === "created" ? created.job.id : "";
    const view = await service().getJob(ws, jobId);
    expect(view?.outputOptions?.look).toBe("keep_photo");
    expect(view?.outputOptions?.lines[0]).toBe("Background kept as you took it, on 1 photo.");

    // A Remove pack whose only photo was kept on its own (P1): the card
    // follows the keep list, and the shots' photos show nothing was removed.
    const ownKept = await deliveredPack(ws, productId, { ...storedOptions("remove", keys), keepMediaIds: [keys[0]] });
    const ownView = await service().getJob(ws, ownKept);
    expect(ownView?.outputOptions?.lines[0]).toBe("Background kept as you took it, on 1 photo.");
    expect(ownView?.outputOptions?.lines.join(" ")).not.toContain("Background removed on your other photos");

    vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.update(generationJobs).set({ outputOptions: { v: 9 } }).where(eq(generationJobs.id, jobId));
    expect((await service().getJob(ws, jobId))?.outputOptions).toBeUndefined();
  });
});

/** A delivered pack with stored options: one white angle needs review with
 * its planned shot stored, and a back angle waits for a photo. */
async function deliveredPack(
  ws: string,
  productId: string,
  outputOptions: Record<string, unknown>,
  channels: string[] = CHANNELS,
): Promise<string> {
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId, status: "done", mode: "listing", channels, outputOptions })
    .returning();
  const shot: Shot = {
    id: "s04_sweep_brand",
    type: "sweep_brand",
    sourceMediaId: `ws/${ws}/src/front.jpg`,
    method: "deterministic",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    credits: creditCosts.deterministic,
    priority: 3,
  };
  await db.insert(assets).values({
    workspaceId: ws,
    jobId: job.id,
    shotType: "sweep_brand",
    approved: false,
    qc: { shotId: shot.id, status: "needs_review", pass: false, credits: shot.credits, shot },
  });
  await db.insert(packFiles).values({
    workspaceId: ws,
    jobId: job.id,
    kind: "report",
    filename: "compliance-report.json",
    r2Key: `ws/${ws}/jobs/${job.id}/pack/compliance-report.json`,
  });
  await db.insert(jobSteps).values([
    { workspaceId: ws, jobId: job.id, shotId: shot.id, stage: "sweep_brand", status: "needs_review" },
    {
      workspaceId: ws,
      jobId: job.id,
      shotId: "skipped_01_alt_angle_white:back",
      stage: "alt_angle_white:back",
      provider: "planner",
      status: "skipped",
      error: "needs photo",
    },
  ]);
  return job.id;
}

function storedOptions(background: "remove" | "keep", keys: string[]): Record<string, unknown> {
  const keep = background === "keep";
  return {
    v: 1,
    look: keep ? "keep_photo" : "marketplace",
    background,
    color: { kind: "swatch", key: "sand" },
    fit: "auto",
    extras: { scenes: !keep, backdrops: !keep, transparentPng: !keep, graphics: !keep, cards: !keep },
    colorHex: backgroundSwatches.sand.hex,
    brandSweepHex: "#1F2A44",
    keepMediaIds: keep ? keys : [],
  };
}

describe("follow ups read the stored options", () => {
  it("runs a retried shot with the snapshotted colors after the kit changed", async () => {
    const { ws, productId, keys } = await workspaceWith("growth", { kit: ["#1F2A44"] });
    const jobId = await deliveredPack(ws, productId, storedOptions("remove", keys));
    await db.update(brandKits).set({ colors: ["#AA0000", "#00AA00"] }).where(eq(brandKits.workspaceId, ws));

    const result = await service().retryShot(ws, jobId, "s04_sweep_brand");
    expect(result.outcome).toBe("started");
    const payload = queue.followUp.mock.calls[0][0] as PackFollowUpInput & { output?: { colorHex: string; brandSweepHex: string } };
    expect(payload.output?.colorHex).toBe(backgroundSwatches.sand.hex);
    expect(payload.output?.brandSweepHex).toBe("#1F2A44");
    expect(payload.brandColors?.[0]).toBe("#1F2A44");
    expect(payload.reencoded).toBeUndefined();
  });

  it("names the shot's photo as re-encoded when its stored copy was written again at upload", async () => {
    const { ws, productId, keys } = await workspaceWith("starter");
    await db
      .update(sourceMedia)
      .set({ ingest: { v: 1, reencoded: true, sourceFormat: "tiff" } })
      .where(eq(sourceMedia.r2Key, keys[0]));
    const jobId = await deliveredPack(ws, productId, storedOptions("keep", keys));

    const result = await service().retryShot(ws, jobId, "s04_sweep_brand");
    expect(result.outcome).toBe("started");
    const payload = queue.followUp.mock.calls[0][0] as PackFollowUpInput;
    expect(payload.reencoded).toEqual([keys[0]]);
  });

  it("plans an added angle on a Keep pack as the seller's own photo and keeps it", async () => {
    const { ws, productId, keys } = await workspaceWith("starter");
    const jobId = await deliveredPack(ws, productId, storedOptions("keep", keys));
    const key = `ws/${ws}/src/back.jpg`;
    const result = await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", { key, sha256: "b".repeat(64) });
    expect(result.outcome).toBe("started");
    const payload = queue.followUp.mock.calls[0][0] as PackFollowUpInput & { output?: { keepMediaIds: string[] } };
    expect(payload.shots[0]).toMatchObject({
      id: "skipped_01_alt_angle_white:back",
      type: "original_photo",
      sourceMediaId: key,
    });
    expect(payload.output?.keepMediaIds).toEqual([...keys, key]);
  });

  it("leaves an added kept photo with added text off eBay, reading the upload preflight", async () => {
    const { ws, productId, keys } = await workspaceWith("starter");
    const jobId = await deliveredPack(ws, productId, storedOptions("keep", keys), [...CHANNELS, "ebay.listing"]);
    const key = `ws/${ws}/src/back.jpg`;
    await db.insert(uploadPreflights).values({
      workspaceId: ws,
      r2Key: key,
      noteKey: "",
      status: "ready",
      result: { status: "ready", addedOverlays: true },
    });
    const result = await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", { key, sha256: "b".repeat(64) });
    expect(result.outcome).toBe("started");
    const payload = queue.followUp.mock.calls[0][0];
    const original = payload.shots.find((s) => s.type === "original_photo");
    expect(original?.sourceMediaId).toBe(key);
    expect(original?.channels).not.toContain("ebay.listing");
    expect(original?.channels).toContain("amazon.secondary");
  });

  it("keeps an added clean photo on eBay", async () => {
    const { ws, productId, keys } = await workspaceWith("starter");
    const jobId = await deliveredPack(ws, productId, storedOptions("keep", keys), [...CHANNELS, "ebay.listing"]);
    const key = `ws/${ws}/src/back.jpg`;
    await db.insert(uploadPreflights).values({
      workspaceId: ws,
      r2Key: key,
      noteKey: "",
      status: "ready",
      result: { status: "ready" },
    });
    const result = await service().addShotPhoto(ws, jobId, "skipped_01_alt_angle_white:back", { key, sha256: "b".repeat(64) });
    expect(result.outcome).toBe("started");
    const payload = queue.followUp.mock.calls[0][0];
    expect(payload.shots.find((s) => s.type === "original_photo")?.channels).toContain("ebay.listing");
    expect(payload.addedOverlays).toBeUndefined();
  });

  it("refuses a follow up when the stored options cannot be read, holding nothing", async () => {
    const { ws, productId } = await workspaceWith("starter");
    const jobId = await deliveredPack(ws, productId, { v: 7 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await service().retryShot(ws, jobId, "s04_sweep_brand");
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(queue.followUp).not.toHaveBeenCalled();
    expect((await jobRow(jobId)).status).toBe("done");
  });
});
