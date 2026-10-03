/**
 * Pack follow ups (a retried shot, an added angle) against the real
 * migrations in PGlite: the follow up's hold is charged only for a shot
 * whose file is delivered, released for anything else, the job always goes
 * back to done, new files never overwrite delivered ones, and a cancel
 * during the follow up stops it with its hold returned.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { assetVariants, assets, creditLedger, generationJobs, packFiles, products, workspaces } from "@curvi/db/schema";
import { endExiftool, type PackFileReport, type Shot } from "@curvi/pipeline";
import { DbJobStore } from "./db-store";
import { ShotUnavailableError } from "./errors";
import {
  followUpShotsWithoutOverlays,
  numberFollowUpFiles,
  runPackFollowUp,
  SOURCE_SELECTION_UNAVAILABLE,
  type PackFollowUpInput,
} from "./follow-up";
import {
  ADDED_OVERLAYS_REASON,
  normalizeOutputOptions,
  resolveColorHex,
  resolveOutputOptions,
  type ResolvedOutputOptions,
} from "@curvi/pipeline/output-options";
import {
  InMemoryJobStore,
  OUTPUT_OPTIONS_UNREADABLE,
  runGeneratePack,
  shotFailureOutcome,
  systemClock,
  type JobLedgerEntry,
  type ShotContext,
  type ShotGenerateArgs,
  type ShotGenerator,
  type ShotOutcome,
  type ShotPackAsset,
} from "./pipeline-runner";
import type { PackUploader } from "./r2";
import { seedJobRecipes } from "./recipes";
import { buildRuntimeDeps } from "./runtime";
import type { JobState } from "./state";

class FakeUploader implements PackUploader {
  readonly bucket = "test-bucket";
  readonly uploads: Array<{ key: string; bytes: number }> = [];

  async upload(localPath: string, key: string): Promise<{ bytes: number }> {
    const info = await stat(localPath);
    this.uploads.push({ key, bytes: info.size });
    return { bytes: info.size };
  }
}

function passing(shotId: string, specIds: string[]): ShotOutcome {
  return {
    shotId,
    shotType: "alt_angle_white",
    specId: specIds[0],
    credits: 0.5,
    status: "passed",
    attempts: 1,
    usedFallbackProvider: false,
    costMicros: 0,
    verdict: { pass: true, fidelity: 1, issues: [], repairHint: "" },
    pixelPass: true,
    fidelityPass: null,
    digitalSource: "none",
    measured: { fillPct: null, background: null },
    outputs: [],
    packAssets: specIds.map((specId): ShotPackAsset => ({ specId, buffer: Buffer.alloc(1), ref: shotId })),
  };
}

describe("numberFollowUpFiles", () => {
  it("numbers new files after the ones each spec already holds", () => {
    const { assets: files, full } = numberFollowUpFiles(
      [passing("a", ["amazon.secondary", "shopify.product"]), passing("b", ["amazon.secondary"])],
      { "amazon.secondary": 3 },
    );
    expect(files.map((f) => [f.ref, f.specId, f.n])).toEqual([
      ["a", "amazon.secondary", 4],
      ["a", "shopify.product", 1],
      ["b", "amazon.secondary", 5],
    ]);
    expect(full.size).toBe(0);
  });

  it("leaves out files past a spec's image limit and names the shots that did not fit", () => {
    // amazon.main takes one image and amazon.secondary eight.
    const { assets: files, full } = numberFollowUpFiles(
      [passing("main", ["amazon.main"]), passing("alt", ["amazon.secondary", "shopify.product"])],
      { "amazon.main": 1, "amazon.secondary": 8 },
    );
    expect(files.map((f) => [f.ref, f.specId])).toEqual([["alt", "shopify.product"]]);
    expect([...full]).toEqual(["main"]);
  });
});

describe("followUpShotsWithoutOverlays", () => {
  const keep = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#FFFFFF",
    keepMediaIds: ["m1", "m2"],
  });
  const original = (id: string, sourceMediaId: string, channels: string[]): Shot => ({
    id,
    type: "original_photo",
    sourceMediaId,
    method: "deterministic",
    channels,
    stylePreset: "none",
    credits: 0.5,
    priority: 2,
  });

  it("leaves a flagged kept photo off the specs that refuse added text and drops a shot left with none", () => {
    const shots = [
      original("a", "m1", ["amazon.secondary", "ebay.listing"]),
      original("b", "m1", ["ebay.listing"]),
      original("c", "m2", ["ebay.listing"]),
    ];
    const { run, refused } = followUpShotsWithoutOverlays(shots, keep, ["m1"]);
    expect(run.map((s) => [s.id, s.channels])).toEqual([
      ["a", ["amazon.secondary"]],
      ["c", ["ebay.listing"]],
    ]);
    expect(refused.map((s) => s.id)).toEqual(["b"]);
  });

  it("passes every shot through without flags or options", () => {
    const shots = [original("b", "m1", ["ebay.listing"])];
    expect(followUpShotsWithoutOverlays(shots, keep, undefined)).toEqual({ run: shots, refused: [] });
    expect(followUpShotsWithoutOverlays(shots, null, ["m1"])).toEqual({ run: shots, refused: [] });
  });
});

describe("runPackFollowUp with an in memory store", () => {
  const shot: Shot = {
    id: "s04_alt_angle_white",
    type: "alt_angle_white",
    sourceMediaId: "m1",
    method: "deterministic",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    scene: "back angle on white",
    credits: 0.5,
    priority: 2,
  };
  const input = (over: Partial<PackFollowUpInput> = {}): PackFollowUpInput => ({
    kind: "follow_up",
    runKey: "run1",
    jobId: "job-1",
    workspaceId: "ws-1",
    reason: "retry",
    shots: [shot],
    sourceSelections: { m1: { version: 1, sourceMediaId: "m1", target: null, exclude: [], otherItems: false } },
    creditBudget: 0.5,
    channels: ["amazon"],
    sku: "MUG1",
    existingFilesBySpec: { "amazon.secondary": 2 },
    baseCostMicros: 0,
    ...over,
  });

  it("charges a shot whose file is delivered and puts the job back to done", async () => {
    const store = new InMemoryJobStore();
    const summary = await runPackFollowUp(input(), { ...buildRuntimeDeps(), store });
    expect(summary).toMatchObject({ state: "done", passed: 1, needsReview: 0, chargedCredits: 0.5, releasedCredits: 0 });
    expect(store.ledger.map((e) => [e.reason, e.credits, e.ref ?? null])).toEqual([
      ["reserve", 0.5, null],
      ["charge", 0.5, shot.id],
    ]);
    expect(store.followUps).toHaveLength(1);
    // Numbered after the two files amazon.secondary already holds.
    expect(store.followUps[0].files[0]).toMatchObject({ ref: shot.id, specId: "amazon.secondary", file: expect.stringMatching(/^MUG1\.PT03\./) });
    expect(store.states.at(-1)?.state).toBe("done");
  });

  it.each([undefined, { m1: { version: 2 } }, { m1: { version: 1, sourceMediaId: "other", target: null, exclude: [], otherItems: false } }])(
    "refuses unreadable or missing source selections before generation",
    async (sourceSelections) => {
      const store = new InMemoryJobStore();
      const generate = vi.fn();
      const summary = await runPackFollowUp(input({ sourceSelections: sourceSelections as PackFollowUpInput["sourceSelections"] }), {
        ...buildRuntimeDeps(), store, generator: { generate },
      });
      expect(summary).toMatchObject({ state: "stopped", error: SOURCE_SELECTION_UNAVAILABLE, chargedCredits: 0, releasedCredits: 0.5 });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("restores exact inventory pieces, exclusions and kept-photo guards and persists them again", async () => {
    const selection = {
      version: 1 as const, basis: "first_run" as const, sourceMediaId: "m1", exclude: ["blue bowl"], otherItems: true,
      target: {
        label: "red mug", box: { x: 0.1, y: 0.1, width: 0.3, height: 0.6 },
        keep: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.6 }], touching: true,
        others: [{ label: "blue bowl", box: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 } }],
      },
    };
    const store = new InMemoryJobStore();
    const seen: ShotGenerateArgs[] = [];
    const summary = await runPackFollowUp(input({ sourceSelections: { m1: selection } }), {
      ...buildRuntimeDeps(), store,
      generator: { generate: async (args) => { seen.push(args); throw new ShotUnavailableError("fixture refusal"); } },
    });
    expect(summary.chargedCredits).toBe(0);
    expect(seen[0].target).toEqual(selection.target);
    expect(seen[0].otherItems).toBe(true);
    expect(store.assets.at(-1)?.sourceSelection).toEqual(selection);
    const generate = vi.fn();
    const unreadable = { ...selection, target: { ...selection.target, newSelectionRule: true } };
    expect(await runPackFollowUp(input({ sourceSelections: { m1: unreadable } }), {
      ...buildRuntimeDeps(), store: new InMemoryJobStore(), generator: { generate },
    })).toMatchObject({ state: "stopped", error: SOURCE_SELECTION_UNAVAILABLE });
    expect(generate).not.toHaveBeenCalled();
  });

  it("hands the stored output options to every shot and stops before any spend on unreadable ones", async () => {
    const white = resolveColorHex({ kind: "swatch", key: "white" }, []) as string;
    const output = resolveOutputOptions(normalizeOutputOptions({ color: { kind: "swatch", key: "sage" } }), {
      colorHex: "#DDE4D8",
      brandSweepHex: white,
      keepMediaIds: [],
    });
    const seen: ShotGenerateArgs[] = [];
    const base = buildRuntimeDeps();
    const recording: ShotGenerator = {
      generate: async (args) => {
        seen.push(args);
        return base.generator.generate(args);
      },
    };
    const store = new InMemoryJobStore();
    const summary = await runPackFollowUp(input({ output, reencoded: ["m1"] }), { ...base, store, generator: recording });
    expect(summary.state).toBe("done");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((args) => args.output?.colorHex === "#DDE4D8" && args.reencodedAtUpload === true)).toBe(true);

    const unreadable = new InMemoryJobStore();
    seen.length = 0;
    const stopped = await runPackFollowUp(
      input({ output: { ...output, v: 2 } as unknown as ResolvedOutputOptions }),
      { ...base, store: unreadable, generator: recording },
    );
    expect(stopped.state).toBe("stopped");
    expect(stopped.error).toBe(OUTPUT_OPTIONS_UNREADABLE);
    expect(seen).toHaveLength(0);
    expect(stopped.chargedCredits).toBe(0);
    expect(stopped.releasedCredits).toBe(0.5);
  });

  it("never runs a kept photo with added text on a spec that refuses it, and returns its credits", async () => {
    const output = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
      colorHex: "#FFFFFF",
      brandSweepHex: "#FFFFFF",
      keepMediaIds: ["m1"],
    });
    const kept: Shot = { ...shot, id: "s09_original_photo", type: "original_photo", channels: ["ebay.listing"] };
    const seen: ShotGenerateArgs[] = [];
    const base = buildRuntimeDeps();
    const store = new InMemoryJobStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await runPackFollowUp(input({ shots: [kept], output, addedOverlays: ["m1"] }), {
      ...base,
      store,
      generator: {
        generate: async (args) => {
          seen.push(args);
          return base.generator.generate(args);
        },
      },
    });
    expect(seen).toHaveLength(0);
    expect(summary).toMatchObject({ state: "done", passed: 0, needsReview: 1, chargedCredits: 0, releasedCredits: 0.5 });
    expect(store.assets.at(-1)).toMatchObject({ shotId: kept.id, status: "needs_review" });
    expect(JSON.stringify(store.assets.at(-1)?.verdict)).toContain(ADDED_OVERLAYS_REASON);
  });

  it("releases a shot that needs review again and charges nothing", async () => {
    const store = new InMemoryJobStore();
    const generator: ShotGenerator = {
      generate: async () => {
        throw new ShotUnavailableError("Still not usable.");
      },
    };
    const summary = await runPackFollowUp(input(), { ...buildRuntimeDeps(), store, generator });
    expect(summary).toMatchObject({ state: "done", passed: 0, needsReview: 1, chargedCredits: 0, releasedCredits: 0.5 });
    expect(store.followUps).toHaveLength(0);
    expect(store.states.at(-1)?.state).toBe("done");
  });

  it("releases a passing shot whose channel is already full", async () => {
    const store = new InMemoryJobStore();
    const summary = await runPackFollowUp(input({ existingFilesBySpec: { "amazon.secondary": 8 } }), {
      ...buildRuntimeDeps(),
      store,
    });
    expect(summary).toMatchObject({ passed: 0, needsReview: 1, chargedCredits: 0, releasedCredits: 0.5 });
    expect(store.assets.at(-1)?.status).toBe("needs_review");
  });

  it("stops at the next checkpoint once the job was canceled and returns the hold", async () => {
    class CanceledStore extends InMemoryJobStore {
      released = 0;
      async heartbeat(): Promise<boolean> {
        return false;
      }
      async releaseAllHeld(): Promise<void> {
        this.released += 1;
      }
    }
    const store = new CanceledStore();
    let generated = 0;
    const generator: ShotGenerator = {
      generate: async () => {
        generated += 1;
        throw new Error("never reached");
      },
    };
    const summary = await runPackFollowUp(input(), { ...buildRuntimeDeps(), store, generator });
    expect(summary.state).toBe("stopped");
    expect(summary.chargedCredits).toBe(0);
    expect(generated).toBe(0);
    expect(store.released).toBe(1);
    // Never "failed": the pack was delivered by its first run.
    expect(store.states.map((s) => s.state)).not.toContain("failed");
  });
});

describe("runPackFollowUp against the ledger", () => {
  let client: PGlite;
  let db: TestDb;
  let ws: string;
  let jobId: string;
  const GRANT = 100;
  const BUDGET = 20;
  const uploader = new FakeUploader();

  async function balance(): Promise<number> {
    const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
    return Number(result.rows[0].credit_balance);
  }

  async function job() {
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    return row;
  }

  /** What the web app does before it queues a follow up: hold the credits
   * against the job and move it back to generating. */
  async function startFollowUp(credits: number): Promise<void> {
    await db.update(generationJobs).set({ status: "generating" }).where(eq(generationJobs.id, jobId));
    await client.query("select reserve_credits($1, $2, $3)", [ws, credits, jobId]);
  }

  async function existingFilesBySpec(): Promise<Record<string, number>> {
    const rows = await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws));
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.channelSpecId] = (counts[row.channelSpecId] ?? 0) + 1;
    }
    return counts;
  }

  async function reviewShot(): Promise<Shot> {
    const rows = await db.select().from(assets).where(eq(assets.jobId, jobId));
    const row = rows.find((a) => !a.approved && a.qc?.shot);
    expect(row, "a shot that needs review with its planned shot stored").toBeDefined();
    return row!.qc!.shot as Shot;
  }

  function followUp(shot: Shot, existing: Record<string, number>, runKey: string): PackFollowUpInput {
    return {
      kind: "follow_up",
      runKey,
      jobId,
      workspaceId: ws,
      reason: "retry",
      shots: [shot],
      sourceSelections: { [shot.sourceMediaId]: { version: 1, sourceMediaId: shot.sourceMediaId, target: null, exclude: [], otherItems: false } },
      creditBudget: shot.credits,
      channels: ["amazon", "shopify"],
      sku: "MUG1",
      seoSlug: "ceramic-mug",
      mode: "listing",
      existingFilesBySpec: existing,
      baseCostMicros: 0,
    };
  }

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    const [w] = await db.insert(workspaces).values({ name: "Follow up", plan: "starter" }).returning();
    ws = w.id;
    const [p] = await db.insert(products).values({ workspaceId: ws, title: "Ceramic mug", mode: "listing" }).returning();
    const [j] = await db.insert(generationJobs).values({ workspaceId: ws, productId: p.id, status: "queued" }).returning();
    jobId = j.id;
    await db.insert(creditLedger).values({ workspaceId: ws, delta: GRANT, reason: "grant", source: "system" });
    await client.query("select reserve_credits($1, $2, $3)", [ws, BUDGET, jobId]);

    // The first run: white alternate angles need review, the rest ships.
    const base = buildRuntimeDeps();
    const inner = base.generator;
    const generator: ShotGenerator = {
      generate: (args) =>
        args.shot.type === "alt_angle_white"
          ? Promise.reject(new ShotUnavailableError("Not usable this time."))
          : inner.generate(args),
    };
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
    const summary = await runGeneratePack(
      {
        jobId,
        workspaceId: ws,
        tier: "starter",
        channels: ["amazon", "shopify"],
        creditBudget: BUDGET,
        images: [{ mediaId: "m1" }],
        sku: "MUG1",
        seoSlug: "ceramic-mug",
        mode: "listing",
      },
      { ...base, generator, store, clock: systemClock },
    );
    expect(summary.state).toBe("done");
    expect(summary.needsReview).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await endExiftool();
    await client.close();
  });

  it("charges exactly the retried shot once its file is delivered", async () => {
    const shot = await reviewShot();
    const before = await balance();
    const chargedBefore = (await job()).creditsCharged;
    const zipsBefore = (await db.select().from(packFiles).where(eq(packFiles.jobId, jobId))).filter(
      (f) => f.kind === "zip",
    );
    await startFollowUp(shot.credits);
    expect(await balance()).toBe(before - shot.credits);

    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
    const summary = await runPackFollowUp(followUp(shot, await existingFilesBySpec(), "r1"), {
      ...buildRuntimeDeps(),
      store,
    });
    expect(summary).toMatchObject({ state: "done", passed: 1, chargedCredits: shot.credits, releasedCredits: 0 });

    const after = await job();
    expect(after.status).toBe("done");
    expect(after.creditsCharged).toBe(chargedBefore + shot.credits);
    expect(await balance()).toBe(before - shot.credits);

    // The new file sits under the follow up's own key, never over a delivered one.
    const variants = await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws));
    const fresh = variants.filter((v) => v.r2Key.includes("/followup-r1/"));
    expect(fresh.length).toBeGreaterThan(0);
    expect(new Set(variants.map((v) => v.r2Key)).size).toBe(variants.length);
    // Channel zips that no longer hold every file are withdrawn; the report stays.
    const packRows = await db.select().from(packFiles).where(eq(packFiles.jobId, jobId));
    const channels = new Set(fresh.map((v) => v.channelSpecId.split(".")[0]));
    expect(packRows.filter((f) => f.kind === "zip" && channels.has(f.channel ?? ""))).toHaveLength(0);
    expect(packRows.filter((f) => f.kind === "zip").length).toBe(
      zipsBefore.filter((z) => !channels.has(z.channel ?? "")).length,
    );
    expect(packRows.filter((f) => f.kind === "report")).toHaveLength(1);

    // The charge is keyed by the shot id and nothing stays held.
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.jobId, jobId));
    expect(ledger.filter((r) => r.reason === "charge" && r.stepKey === shot.id)).toHaveLength(1);
    const held = ledger.filter((r) => r.reason === "reserve" || r.reason === "release").reduce((s, r) => s - r.delta, 0);
    expect(held).toBe(0);
  });

  it("delivers a regenerated scene unpicked despite a full channel and saves its own checks", async () => {
    const shot: Shot = { ...(await reviewShot()), id: "scene.v2", type: "lifestyle", method: "composite_generate", variation: 2, credits: 2, channels: ["amazon.secondary"] };
    const before = await balance();
    await startFollowUp(shot.credits);
    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
    const input = { ...followUp(shot, { "amazon.secondary": 8 }, "regen2"), reason: "regenerate" as const };
    const summary = await runPackFollowUp(input, { ...buildRuntimeDeps(), store });
    expect(summary).toMatchObject({ state: "done", passed: 1, chargedCredits: shot.credits, releasedCredits: 0 });
    const fresh = (await db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws)))
      .filter((v) => v.r2Key.includes("/followup-regen2/"));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((v) => !v.picked)).toBe(true);
    const saved = await db.select().from(assets).where(eq(assets.jobId, jobId));
    for (const file of fresh) {
      const qc = saved.find((a) => a.id === file.assetId)?.qc;
      expect((qc?.fileReports as Record<string, unknown>)?.[file.r2Key]).toMatchObject({ file: file.filename, specId: file.channelSpecId, ref: shot.id });
    }
    expect(await balance()).toBe(before - shot.credits);
  });

  it("returns the whole hold when the follow up is canceled before it runs", async () => {
    const shot = await reviewShot();
    const before = await balance();
    const chargedBefore = (await job()).creditsCharged;
    await startFollowUp(shot.credits);
    // A cancel settles the job first: it is terminal when the runner looks.
    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, jobId));

    const store = new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
    const summary = await runPackFollowUp(followUp(shot, await existingFilesBySpec(), "r2"), {
      ...buildRuntimeDeps(),
      store,
    });
    expect(summary.state).toBe("stopped");
    expect(await balance()).toBe(before);
    expect((await job()).creditsCharged).toBe(chargedBefore);
    expect((await job()).status).toBe("done");
  });
});

describe("runPackFollowUp carries the first run's context (reviewer items 2 and 3)", () => {
  const shotFor = (id: string, channels: string[] = ["amazon.secondary"]): Shot => ({
    id,
    type: "alt_angle_white",
    sourceMediaId: "m1",
    method: "deterministic",
    channels,
    stylePreset: "none",
    scene: "back angle on white",
    credits: 0.5,
    priority: 2,
  });
  const input = (over: Partial<PackFollowUpInput> = {}): PackFollowUpInput => ({
    kind: "follow_up",
    runKey: "run-ctx",
    jobId: "job-ctx",
    workspaceId: "ws-ctx",
    reason: "add_angle",
    shots: [shotFor("s04_alt_angle_white")],
    sourceSelections: { m1: { version: 1, sourceMediaId: "m1", target: null, exclude: [], otherItems: false } },
    creditBudget: 0.5,
    channels: ["amazon", "meta"],
    sku: "MUG1",
    existingFilesBySpec: {},
    baseCostMicros: 0,
    ...over,
  });

  it("returns the hold before the job goes back to done when the follow up fails", async () => {
    class OrderedStore extends InMemoryJobStore {
      readonly events: string[] = [];
      async setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<boolean> {
        this.events.push(`state:${state}`);
        return super.setJobState(jobId, state, meta);
      }
      async appendLedger(entry: JobLedgerEntry): Promise<void> {
        this.events.push(`ledger:${entry.reason}`);
        return super.appendLedger(entry);
      }
      async releaseAllHeld(): Promise<void> {
        this.events.push("sweep");
      }
      async saveFollowUpFiles(): Promise<string[]> {
        throw new Error("storage is down");
      }
    }
    const store = new OrderedStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = await runPackFollowUp(input(), { ...buildRuntimeDeps(), store });
    expect(summary.state).toBe("stopped");
    const done = store.events.indexOf("state:done");
    expect(done).toBeGreaterThan(-1);
    expect(store.events.indexOf("ledger:release")).toBeLessThan(done);
    expect(store.events.indexOf("sweep")).toBeLessThan(done);
    expect(store.events.indexOf("sweep")).toBeGreaterThan(-1);
  });

  it("gives its shots the brand kit, the recorded recipe versions and the run key", async () => {
    const recipes = seedJobRecipes();
    const forVariants = vi.fn(async () => recipes);
    const forJob = vi.fn(async () => ({}));
    const brand = { fonts: { heading: "inter", body: "inter" }, logoKey: "ws/ws-ctx/brand/logo.png", stylePreset: null };
    const recipeVariants = { qc_judge: { recipeId: "r-qc-2", version: 2, source: "db" as const } };
    let seen: ShotContext | null = null;
    const store = new InMemoryJobStore();
    await runPackFollowUp(input({ brand, recipeVariants }), {
      ...buildRuntimeDeps(),
      store,
      recipes: { forJob, forVariants },
      runShots: async (shots, ctx) => {
        seen = ctx;
        return shots.map((s) => shotFailureOutcome(s, ctx, "test"));
      },
    });
    expect(forVariants).toHaveBeenCalledWith("job-ctx", recipeVariants);
    expect(forJob).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ brand, recipes, runKey: "run-ctx", brandColors: undefined });
  });

  it("runs an added angle's shots under the shot concurrency limit", async () => {
    const base = buildRuntimeDeps();
    let running = 0;
    let most = 0;
    const generator: ShotGenerator = {
      generate: async (args) => {
        running += 1;
        most = Math.max(most, running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return await base.generator.generate(args);
        } finally {
          running -= 1;
        }
      },
    };
    const shots = ["s04_a", "s05_b", "s06_c", "s07_d"].map((id) => shotFor(id));
    const summary = await runPackFollowUp(input({ shots, creditBudget: 2 }), {
      ...base,
      store: new InMemoryJobStore(),
      generator,
      shotConcurrency: 2,
    });
    expect(summary.passed + summary.needsReview).toBe(4);
    expect(most).toBe(2);
  });

  it("draws the social badge when the plan asks for it, as a first run does", async () => {
    const badgeOf = async (socialBadge: boolean): Promise<boolean[]> => {
      const store = new InMemoryJobStore();
      const summary = await runPackFollowUp(
        input({ shots: [shotFor("s04_alt_angle_white", ["meta.feed_1x1"])], socialBadge }),
        { ...buildRuntimeDeps(), store },
      );
      expect(summary.passed).toBe(1);
      const report = JSON.parse(
        await readFile(path.join(store.followUps[0].outDir, "compliance-report.json"), "utf8"),
      ) as { files: PackFileReport[] };
      return report.files.filter((f) => f.specId === "meta.feed_1x1").map((f) => f.badge);
    };
    expect(await badgeOf(true)).toEqual([true]);
    expect(await badgeOf(false)).toEqual([false]);
  });
});
