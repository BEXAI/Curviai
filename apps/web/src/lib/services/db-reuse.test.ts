/**
 * Reuse, scene versions, favorites and the library on DbService against the
 * real migrations in PGlite (docs/phases/PHASE_16.md workstream 6):
 * - "Make this pack again" restores every stored field, only in the job's
 *   own workspace, and never writes anything;
 * - an unpicked version never reaches the pack's files or the all files
 *   zip rows, picking one refuses a full channel, and no pick touches the
 *   ledger;
 * - favorites are workspace scoped: an asset of another workspace is a not
 *   found, and a client seat cannot change them;
 * - the library lists picked files only, filtered.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assetVariants,
  assets,
  creditLedger,
  favorites,
  generationJobs,
  jobSteps,
  members,
  packFiles,
  products,
  signupGrants,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { NO_FILTERS } from "@/lib/library";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn(async () => "inline") }));

import { DbService } from "./db";

const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" };

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 700;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  for (const name of Object.keys(R2_ENV)) {
    delete process.env[name];
  }
});

interface Ws {
  id: string;
  owner: string;
  clientSeat: string;
  productId: string;
}

async function makeWorkspace(): Promise<Ws> {
  counter += 2;
  const owner = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const clientSeat = `00000000-0000-4000-8000-${String(counter + 1).padStart(12, "0")}`;
  const [w] = await db.insert(workspaces).values({ name: `WS ${counter}`, plan: "growth" }).returning();
  await db.insert(members).values([
    { workspaceId: w.id, userId: owner, role: "owner" },
    { workspaceId: w.id, userId: clientSeat, role: "client" },
  ]);
  await db.insert(signupGrants).values({ userId: owner, workspaceId: w.id, credits: 0 });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Kettle", mode: "listing" }).returning();
  return { id: w.id, owner, clientSeat, productId: p.id };
}

function service(user: string): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => user, getSupabase: async () => null });
}

interface ShotSeed {
  shotId: string;
  shotType: string;
  specs: string[];
  picked: boolean;
}

/** A delivered pack with these shots, one file per spec, and channel zips. */
async function deliveredJob(w: Ws, shots: ShotSeed[], extra: Partial<typeof generationJobs.$inferInsert> = {}) {
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: w.id, productId: w.productId, status: "done", updatedAt: new Date(), ...extra })
    .returning();
  const assetIds = new Map<string, string>();
  for (const [i, shot] of shots.entries()) {
    const [asset] = await db
      .insert(assets)
      .values({ workspaceId: w.id, jobId: job.id, shotType: shot.shotType, approved: true, qc: { shotId: shot.shotId } })
      .returning();
    assetIds.set(shot.shotId, asset.id);
    for (const spec of shot.specs) {
      await db.insert(assetVariants).values({
        workspaceId: w.id,
        assetId: asset.id,
        channelSpecId: spec,
        r2Key: `ws/${w.id}/jobs/${job.id}/files/${spec.split(".")[0]}/${shot.shotId}-${i}.jpg`,
        filename: `K1.PT0${i + 1}.jpg`,
        bytes: 100,
        width: 2000,
        height: 1500,
        picked: shot.picked,
      });
    }
    await db.insert(jobSteps).values({
      workspaceId: w.id,
      jobId: job.id,
      shotId: shot.shotId,
      stage: shot.shotType,
      provider: "worker",
      status: "done",
    });
  }
  for (const channel of ["amazon", "shopify"]) {
    await db.insert(packFiles).values({
      workspaceId: w.id,
      jobId: job.id,
      kind: "zip",
      channel,
      filename: `${channel}.zip`,
      r2Key: `ws/${w.id}/jobs/${job.id}/pack/${channel}.zip`,
      bytes: 10,
    });
  }
  return { jobId: job.id, assetIds };
}

const SCENE_SHOTS: ShotSeed[] = [
  { shotId: "s01_amazon_main", shotType: "amazon_main", specs: ["amazon.main"], picked: true },
  { shotId: "s05_lifestyle", shotType: "lifestyle", specs: ["amazon.secondary", "shopify.product"], picked: true },
  { shotId: "s05_lifestyle.v2", shotType: "lifestyle", specs: ["amazon.secondary", "shopify.product"], picked: false },
];

describe("getReusePrefill", () => {
  it("restores the channels, options, bundle, versions, answers and note of the pack", async () => {
    const w = await makeWorkspace();
    const output = resolveOutputOptions(
      normalizeOutputOptions({ background: "remove", bundle: "listing", variations: 3, sceneCount: 2, extras: { cards: false } }),
      { colorHex: stillStyle.whiteHex, brandSweepHex: stillStyle.whiteHex, keepMediaIds: [] },
    );
    const { jobId } = await deliveredJob(w, [], {
      channels: ["amazon.main", "etsy.listing"],
      mode: "listing",
      outputOptions: output,
      sellerAnswers: { version: 1, mood: { value: "cozy", label: "Cozy" }, channels: { value: "amazon", label: "Amazon" } },
      sellerNote: "Only the blue kettle.",
    });

    const before = await db.select().from(generationJobs);
    const prefill = await service(w.owner).getReusePrefill(w.id, jobId);
    expect(prefill).toMatchObject({
      jobId,
      productId: w.productId,
      mode: "listing",
      channels: ["amazon.main", "etsy.listing"],
      answers: { mood: "cozy", channels: "amazon" },
      note: "Only the blue kettle.",
    });
    // Every choice the pack carried, none of the resolved snapshot.
    expect(prefill?.outputOptions).toMatchObject({ bundle: "listing", variations: 3, sceneCount: 2, background: "remove" });
    expect(prefill?.outputOptions).not.toHaveProperty("colorHex");
    expect(prefill?.outputOptions).not.toHaveProperty("keepMediaIds");
    expect(normalizeOutputOptions(prefill?.outputOptions as never)).toMatchObject({ bundle: "listing", variations: 3 });
    // A prefill only: nothing was written.
    expect(await db.select().from(generationJobs)).toHaveLength(before.length);
  });

  it("finds nothing outside the caller's workspace", async () => {
    const w = await makeWorkspace();
    const other = await makeWorkspace();
    const { jobId } = await deliveredJob(other, []);
    expect(await service(w.owner).getReusePrefill(w.id, jobId)).toBeNull();
    expect(await service(w.owner).getReusePrefill(w.id, "not-a-uuid")).toBeNull();
  });
});

describe("scene versions", () => {
  it("shows every version on the board but lists only picked files", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace();
    const { jobId } = await deliveredJob(w, SCENE_SHOTS);
    const job = await service(w.owner).getJob(w.id, jobId);
    const scene = job?.shots.find((s) => s.shotId === "s05_lifestyle");
    const v2 = job?.shots.find((s) => s.shotId === "s05_lifestyle.v2");
    expect(scene?.version).toEqual({ number: 1, sceneShotId: "s05_lifestyle", picked: true });
    expect(v2?.version).toEqual({ number: 2, sceneShotId: "s05_lifestyle", picked: false });
    expect(job?.shots.find((s) => s.shotId === "s01_amazon_main")?.version).toBeUndefined();
    expect(scene?.width).toBe(2000);
    expect(scene?.height).toBe(1500);

    const files = await service(w.owner).listJobFiles(w.id, jobId);
    const images = files?.files.filter((f) => f.kind === "image") ?? [];
    expect(images).toHaveLength(3);
    expect(images.some((f) => f.name === "K1.PT03.jpg")).toBe(false);
  });

  it("picks a version, drops the stale channel zips and never touches the ledger", async () => {
    const w = await makeWorkspace();
    const { jobId, assetIds } = await deliveredJob(w, SCENE_SHOTS);
    const ledgerBefore = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, w.id));

    const result = await service(w.owner).pickShotVersion(w.id, jobId, "s05_lifestyle.v2", true);
    expect(result.outcome).toBe("saved");
    const rows = await db.select().from(assetVariants).where(eq(assetVariants.assetId, assetIds.get("s05_lifestyle.v2")!));
    expect(rows.every((r) => r.picked)).toBe(true);
    const zips = await db.select().from(packFiles).where(eq(packFiles.jobId, jobId));
    expect(zips.filter((z) => z.kind === "zip")).toHaveLength(0);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, w.id))).toEqual(ledgerBefore);

    const back = await service(w.owner).pickShotVersion(w.id, jobId, "s05_lifestyle", false);
    expect(back.outcome).toBe("saved");
    if (back.outcome === "saved") {
      expect(back.job.shots.find((s) => s.shotId === "s05_lifestyle")?.version?.picked).toBe(false);
      expect(back.job.shots.find((s) => s.shotId === "s05_lifestyle.v2")?.version?.picked).toBe(true);
    }
  });

  it("refuses a pick that would put a channel past its file limit", async () => {
    const w = await makeWorkspace();
    // amazon.secondary takes 8 files; eight are already picked.
    const fillers: ShotSeed[] = Array.from({ length: 7 }, (_, i) => ({
      shotId: `s1${i}_alt_angle_white`,
      shotType: "alt_angle_white",
      specs: ["amazon.secondary"],
      picked: true,
    }));
    const { jobId, assetIds } = await deliveredJob(w, [...SCENE_SHOTS, ...fillers]);
    const result = await service(w.owner).pickShotVersion(w.id, jobId, "s05_lifestyle.v2", true);
    expect(result).toMatchObject({ outcome: "rejected", reason: "channel_full" });
    const rows = await db.select().from(assetVariants).where(eq(assetVariants.assetId, assetIds.get("s05_lifestyle.v2")!));
    expect(rows.every((r) => !r.picked)).toBe(true);
  });

  it("refuses shots that are not versions, client seats and other workspaces", async () => {
    const w = await makeWorkspace();
    const other = await makeWorkspace();
    const { jobId } = await deliveredJob(w, SCENE_SHOTS);
    expect(await service(w.owner).pickShotVersion(w.id, jobId, "s01_amazon_main", false)).toMatchObject({
      reason: "not_a_version",
    });
    expect(await service(w.clientSeat).pickShotVersion(w.id, jobId, "s05_lifestyle.v2", true)).toMatchObject({
      reason: "role_forbidden",
    });
    expect(await service(other.owner).pickShotVersion(other.id, jobId, "s05_lifestyle.v2", true)).toMatchObject({
      reason: "not_found",
    });
  });

  it("waits for the pack to finish", async () => {
    const w = await makeWorkspace();
    const { jobId } = await deliveredJob(w, SCENE_SHOTS, { status: "packaging" });
    expect(await service(w.owner).pickShotVersion(w.id, jobId, "s05_lifestyle.v2", true)).toMatchObject({
      reason: "not_ready",
    });
  });
});

describe("favorites", () => {
  it("adds and removes a favorite of the workspace's own asset, once", async () => {
    const w = await makeWorkspace();
    const { assetIds } = await deliveredJob(w, SCENE_SHOTS);
    const assetId = assetIds.get("s01_amazon_main")!;
    expect(await service(w.owner).setFavorite(w.id, assetId, true)).toEqual({ outcome: "saved", favorite: true });
    expect(await service(w.owner).setFavorite(w.id, assetId, true)).toEqual({ outcome: "saved", favorite: true });
    const rows = await db.select().from(favorites).where(eq(favorites.workspaceId, w.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId, createdBy: w.owner });
    expect(await service(w.owner).setFavorite(w.id, assetId, false)).toEqual({ outcome: "saved", favorite: false });
    expect(await db.select().from(favorites).where(eq(favorites.workspaceId, w.id))).toHaveLength(0);
  });

  it("is workspace scoped: another workspace's asset is not found and writes nothing", async () => {
    const w = await makeWorkspace();
    const other = await makeWorkspace();
    const { assetIds } = await deliveredJob(other, SCENE_SHOTS);
    const theirs = assetIds.get("s01_amazon_main")!;
    expect(await service(w.owner).setFavorite(w.id, theirs, true)).toMatchObject({ outcome: "rejected", reason: "not_found" });
    expect(await db.select().from(favorites).where(eq(favorites.assetId, theirs))).toHaveLength(0);
  });

  it("refuses a client seat", async () => {
    const w = await makeWorkspace();
    const { assetIds } = await deliveredJob(w, SCENE_SHOTS);
    expect(await service(w.clientSeat).setFavorite(w.id, assetIds.get("s01_amazon_main")!, true)).toMatchObject({
      reason: "role_forbidden",
    });
  });

  it("marks favorites on the board", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace();
    const { jobId, assetIds } = await deliveredJob(w, SCENE_SHOTS);
    await service(w.owner).setFavorite(w.id, assetIds.get("s01_amazon_main")!, true);
    const job = await service(w.owner).getJob(w.id, jobId);
    expect(job?.shots.find((s) => s.shotId === "s01_amazon_main")).toMatchObject({
      favorite: true,
      assetId: assetIds.get("s01_amazon_main"),
    });
  });
});

describe("listLibrary", () => {
  it("lists picked images of finished packs, with filters and facets, in this workspace only", async () => {
    Object.assign(process.env, R2_ENV);
    const w = await makeWorkspace();
    const other = await makeWorkspace();
    const { assetIds } = await deliveredJob(w, SCENE_SHOTS);
    await deliveredJob(w, SCENE_SHOTS, { status: "packaging", creditsCharged: 0 });
    await deliveredJob(other, SCENE_SHOTS);
    await service(w.owner).setFavorite(w.id, assetIds.get("s05_lifestyle")!, true);

    const all = await service(w.owner).listLibrary(w.id, NO_FILTERS);
    // The unpicked version and the unfinished pack are left out.
    expect(all.items.map((i) => i.shotId).sort()).toEqual(["s01_amazon_main", "s05_lifestyle"]);
    expect(all.items.every((i) => i.imageUrl?.includes("X-Amz-Signature"))).toBe(true);
    expect(all.facets.channels.map((c) => c.value).sort()).toEqual(["amazon", "shopify"]);
    const scene = all.items.find((i) => i.shotId === "s05_lifestyle");
    expect(scene).toMatchObject({ width: 2000, height: 1500, favorite: true, productTitle: "Kettle" });

    const shopify = await service(w.owner).listLibrary(w.id, { ...NO_FILTERS, channel: "shopify" });
    expect(shopify.items.map((i) => i.shotId)).toEqual(["s05_lifestyle"]);
    const mains = await service(w.owner).listLibrary(w.id, { ...NO_FILTERS, shotType: "amazon_main" });
    expect(mains.items.map((i) => i.shotId)).toEqual(["s01_amazon_main"]);
    const liked = await service(w.owner).listLibrary(w.id, { ...NO_FILTERS, favorites: true });
    expect(liked.items.map((i) => i.shotId)).toEqual(["s05_lifestyle"]);
    expect((await service(other.owner).listLibrary(other.id, { ...NO_FILTERS, favorites: true })).items).toEqual([]);
  });
});
