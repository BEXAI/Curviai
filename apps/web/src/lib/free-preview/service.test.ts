/**
 * The free preview service and the claim against the real migrations in
 * PGlite (docs/phases/PHASE_18.md P18-12): the row, the files under
 * anon/preview/{id}/, the day's count and spend on the preview key, the
 * full size email gate, and the single use claim that moves the photo and
 * its cutout into the new workspace.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCapStore } from "@curvi/ai/testing";
import { events, freePreviews, members, products, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";
import { encodePng } from "@curvi/pipeline";
import { freePreview } from "@curvi/pipeline/seed";
import type { FreePreviewArgs, FreePreviewRun } from "@curvi/trigger/free-preview";
import { MemoryLeadStore } from "@/lib/leads";
import { claimFreePreview, claimedSourceKey, PREVIEW_PRODUCT_TITLE } from "./claim";
import { previewCountKey, previewSpendKey } from "./gate";
import {
  createFreePreview,
  emailKeyOf,
  previewCutoutKey,
  previewMainKey,
  previewOriginalKey,
  unlockFullSize,
  type PreviewStorage,
} from "./service";

const NOW = new Date("2026-10-01T15:00:00Z");
const IP = "203.0.113.10";

class MemoryStorage implements PreviewStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly signed: Array<{ key: string; filename: string; seconds: number }> = [];
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async signDownload(key: string, filename: string, seconds: number) {
    this.signed.push({ key, filename, seconds });
    return `https://r2.example/${key}?sig=1`;
  }
}

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let photo: Buffer;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const width = 64;
  const height = 48;
  const data = Buffer.alloc(width * height * 4, 255);
  photo = await encodePng({ data, width, height, channels: 4 });
});

afterAll(async () => {
  await client.close();
});

function doneRun(overrides: Partial<FreePreviewRun> = {}): FreePreviewRun {
  return {
    status: "done",
    reason: null,
    moderation: [],
    cutout: { bytes: Buffer.from("cutout-png"), contentType: "image/png" },
    main: { bytes: Buffer.from("main-jpeg"), format: "jpeg", width: 2000, height: 2000 },
    preview: Buffer.from("preview-jpeg"),
    checks: [
      { name: "backgroundWhiteShare", pass: true, measured: 1, limit: ">= 0.995" },
      { name: "fillRatio", pass: true, measured: 0.86, limit: "0.85 to 1" },
    ],
    checksPass: true,
    fillPct: 86,
    fidelity: { meanDeltaE: 0.42, maxDeltaE: 3.1, exactByteShare: 0.61, threshold: 3, pass: true },
    costMicros: 11_000,
    ...overrides,
  };
}

function serviceDeps(run: (args: FreePreviewArgs) => Promise<FreePreviewRun>) {
  return {
    db: db as unknown as Db,
    counters: new InMemoryCapStore(),
    storage: new MemoryStorage(),
    run: vi.fn(run),
    now: () => NOW,
  };
}

async function rowOf(id: string) {
  const [row] = await db.select().from(freePreviews).where(eq(freePreviews.id, id));
  return row;
}

describe("createFreePreview", () => {
  it("makes a preview: row done, files under anon/preview, count and spend booked on the preview key", async () => {
    const deps = serviceDeps(async () => doneRun());
    const result = await createFreePreview(deps, { bytes: photo, ip: IP });
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.preview).toBe(`data:image/jpeg;base64,${Buffer.from("preview-jpeg").toString("base64")}`);
    expect(result.fidelity).toEqual({ meanDeltaE: 0.42, maxDeltaE: 3.1, exactByteShare: 0.61 });
    expect(result.checks).toEqual([
      { name: "backgroundWhiteShare", pass: true },
      { name: "fillRatio", pass: true },
    ]);
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({ previewId: result.previewId, previewLongSide: freePreview.previewLongSide }),
    );

    const row = await rowOf(result.previewId);
    expect(row).toMatchObject({ status: "done", costMicros: 11_000, sourceFormat: "png", mainFormat: "jpeg", emailKey: null });
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.expiresAt.getTime() - NOW.getTime()).toBe(freePreview.retentionDays * 86_400_000);
    expect([...deps.storage.objects.keys()].sort()).toEqual(
      [
        previewOriginalKey(result.previewId, "png"),
        previewCutoutKey(result.previewId),
        previewMainKey(result.previewId, "jpeg"),
      ].sort(),
    );
    for (const key of deps.storage.objects.keys()) {
      expect(key.startsWith(`anon/preview/${result.previewId}/`)).toBe(true);
    }
    expect(await deps.counters.get(previewCountKey(NOW))).toBe(1);
    expect(await deps.counters.get(previewSpendKey(NOW))).toBe(11_000);
    const made = await db
      .select()
      .from(events)
      .where(eq(events.name, "funnel.preview_made"));
    expect(made.at(-1)?.props).toMatchObject({ status: "done", checks_pass: true });
    expect(made.at(-1)?.workspaceId).toBeNull();
  });

  it("keeps the slot and books the spend of a moderation block, and stores no output", async () => {
    const deps = serviceDeps(async () =>
      doneRun({ status: "blocked", reason: "moderation", moderation: ["weapons"], cutout: null, main: null, preview: null, fidelity: null, costMicros: 900 }),
    );
    const result = await createFreePreview(deps, { bytes: photo, ip: IP });
    expect(result).toMatchObject({ kind: "blocked" });
    if (result.kind !== "blocked") return;
    expect(await rowOf(result.previewId)).toMatchObject({ status: "blocked", blockedReason: "moderation: weapons", costMicros: 900 });
    // A photo moderation stopped is never stored.
    expect([...deps.storage.objects.keys()]).toEqual([]);
    expect(await deps.counters.get(previewCountKey(NOW))).toBe(1);
    expect(await deps.counters.get(previewSpendKey(NOW))).toBe(900);
  });

  it("reports a failed cutout and an unavailable service plainly", async () => {
    const failed = await createFreePreview(
      serviceDeps(async () => doneRun({ status: "failed", reason: "fidelity", main: null, preview: null })),
      { bytes: photo, ip: IP },
    );
    expect(failed).toMatchObject({ kind: "failed", message: expect.stringContaining("could not make a clean cutout") });
    const down = await createFreePreview(
      serviceDeps(async () => doneRun({ status: "unavailable", reason: "cutout_unavailable", main: null, preview: null, costMicros: 0 })),
      { bytes: photo, ip: IP },
    );
    expect(down).toMatchObject({ kind: "unavailable" });
    if (down.kind === "unavailable") {
      expect((await rowOf(down.previewId)).status).toBe("failed");
    }
  });

  it("refuses a file that is not a photo, giving the slot back and calling no provider", async () => {
    const deps = serviceDeps(async () => doneRun());
    const before = (await db.select().from(freePreviews)).length;
    const result = await createFreePreview(deps, { bytes: Buffer.from("not an image at all"), ip: IP });
    expect(result.kind).toBe("refused");
    expect(deps.run).not.toHaveBeenCalled();
    expect(await deps.counters.get(previewCountKey(NOW))).toBe(0);
    expect((await db.select().from(freePreviews)).length).toBe(before);
  });

  it("stops at the site wide day cap before any work", async () => {
    const deps = serviceDeps(async () => doneRun());
    await deps.counters.add(previewCountKey(NOW), freePreview.sitePerDay);
    expect(await createFreePreview(deps, { bytes: photo, ip: IP })).toEqual({ kind: "daily_limit" });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("marks the row failed, with its spend, when the files cannot be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = serviceDeps(async () => doneRun());
    deps.storage.put = async () => {
      throw new Error("R2 down");
    };
    const result = await createFreePreview(deps, { bytes: photo, ip: IP });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(await rowOf(result.previewId)).toMatchObject({ status: "failed", blockedReason: "storage", costMicros: 11_000 });
    }
    expect(await deps.counters.get(previewSpendKey(NOW))).toBe(11_000);
  });

  it("marks the row failed when the run throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = serviceDeps(async () => {
      throw new Error("worker crashed");
    });
    const result = await createFreePreview(deps, { bytes: photo, ip: IP });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect((await rowOf(result.previewId)).status).toBe("failed");
    }
  });
});

describe("unlockFullSize", () => {
  it("stores the email as a free-preview lead, keeps only its hash, and signs the main file for the seeded time", async () => {
    const deps = serviceDeps(async () => doneRun());
    const made = await createFreePreview(deps, { bytes: photo, ip: IP });
    if (made.kind !== "done") throw new Error("expected a preview");
    const leads = new MemoryLeadStore();
    const result = await unlockFullSize({ ...deps, leads }, { previewId: made.previewId, email: "Seller@Example.com" });
    expect(result).toEqual({ kind: "ready", url: `https://r2.example/${previewMainKey(made.previewId, "jpeg")}?sig=1` });
    expect(deps.storage.signed).toEqual([
      { key: previewMainKey(made.previewId, "jpeg"), filename: "curvi-amazon-main.jpg", seconds: freePreview.fullSizeLinkSeconds },
    ]);
    expect(leads.rows.get("Seller@Example.com")?.source).toBe("free-preview");
    expect(leads.rows.get("Seller@Example.com")?.marketingConsentAt).toBeUndefined();
    const row = await rowOf(made.previewId);
    expect(row.emailKey).toBe(emailKeyOf("seller@example.com"));
    expect(JSON.stringify(row)).not.toContain("example.com");
    await unlockFullSize({ ...deps, leads }, { previewId: made.previewId, email: "consented@example.com", marketingConsent: true });
    expect(leads.rows.get("consented@example.com")?.marketingConsentAt).toBeInstanceOf(Date);
    expect(leads.rows.get("consented@example.com")?.consentSource).toMatch(/^free-preview@/);
  });

  it("refuses an expired, blocked or unknown preview", async () => {
    const leads = new MemoryLeadStore();
    const deps = serviceDeps(async () => doneRun());
    const made = await createFreePreview(deps, { bytes: photo, ip: IP });
    if (made.kind !== "done") throw new Error("expected a preview");
    const later = { ...deps, leads, now: () => new Date(NOW.getTime() + 3 * 86_400_000) };
    expect(await unlockFullSize(later, { previewId: made.previewId, email: "a@example.com" })).toEqual({ kind: "not_found" });
    const blocked = await createFreePreview(
      serviceDeps(async () => doneRun({ status: "blocked", reason: "no_product", main: null, preview: null })),
      { bytes: photo, ip: IP },
    );
    if (blocked.kind !== "blocked") throw new Error("expected a block");
    expect(await unlockFullSize({ ...deps, leads }, { previewId: blocked.previewId, email: "a@example.com" })).toEqual({
      kind: "not_found",
    });
    expect(
      await unlockFullSize({ ...deps, leads }, { previewId: "00000000-0000-4000-8000-00000000dead", email: "a@example.com" }),
    ).toEqual({ kind: "not_found" });
    expect(leads.rows.size).toBe(0);
  });
});

describe("claimFreePreview", () => {
  let counter = 0;

  async function newOwner(): Promise<{ userId: string; workspaceId: string }> {
    counter += 1;
    const userId = `00000000-0000-4000-8000-${String(1200 + counter).padStart(12, "0")}`;
    const [w] = await db.insert(workspaces).values({ name: `Claimer ${counter}` }).returning();
    await db.insert(members).values({ workspaceId: w.id, userId, role: "owner" });
    return { userId, workspaceId: w.id };
  }

  let storage: MemoryStorage;
  let previewId: string;

  beforeEach(async () => {
    const deps = serviceDeps(async () => doneRun());
    const made = await createFreePreview(deps, { bytes: photo, ip: IP });
    if (made.kind !== "done") throw new Error("expected a preview");
    storage = deps.storage;
    previewId = made.previewId;
  });

  function claimDeps(now = NOW) {
    return {
      db: db as unknown as Db,
      storage,
      now: () => now,
      cacheKeyFor: async (ws: string) => `ws/${ws}/cache/cutout/${"c".repeat(64)}.png`,
    };
  }

  it("moves the photo and its cutout into the new workspace once, as its first product", async () => {
    const owner = await newOwner();
    const result = await claimFreePreview(claimDeps(), { previewId, userId: owner.userId });
    expect(result).toMatchObject({ kind: "claimed", workspaceId: owner.workspaceId });
    if (result.kind !== "claimed") return;

    const sourceKey = claimedSourceKey(owner.workspaceId, previewId, "png");
    expect(storage.objects.get(sourceKey)?.body.equals(photo)).toBe(true);
    expect(storage.objects.get(`ws/${owner.workspaceId}/cache/cutout/${"c".repeat(64)}.png`)?.body.toString()).toBe(
      "cutout-png",
    );
    const [product] = await db.select().from(products).where(eq(products.id, result.productId));
    expect(product).toMatchObject({ workspaceId: owner.workspaceId, title: PREVIEW_PRODUCT_TITLE, mode: "listing" });
    const media = await db.select().from(sourceMedia).where(eq(sourceMedia.productId, result.productId));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ r2Key: sourceKey, kind: "image", workspaceId: owner.workspaceId });
    expect(media[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await rowOf(previewId)).toMatchObject({ status: "claimed", claimedWorkspaceId: owner.workspaceId });
    const claimed = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, owner.workspaceId), eq(events.name, "funnel.preview_claimed")));
    expect(claimed).toHaveLength(1);

    // Idempotent for the same workspace: the same product, nothing new.
    const again = await claimFreePreview(claimDeps(), { previewId, userId: owner.userId });
    expect(again).toEqual({ kind: "already", productId: result.productId, workspaceId: owner.workspaceId });
    expect(await db.select().from(products).where(eq(products.workspaceId, owner.workspaceId))).toHaveLength(1);
  });

  it("refuses a second workspace, an expired preview and an unknown one", async () => {
    const first = await newOwner();
    const second = await newOwner();
    expect((await claimFreePreview(claimDeps(), { previewId, userId: first.userId })).kind).toBe("claimed");
    expect(await claimFreePreview(claimDeps(), { previewId, userId: second.userId })).toEqual({
      kind: "refused",
      reason: "taken",
    });
    expect(await db.select().from(products).where(eq(products.workspaceId, second.workspaceId))).toHaveLength(0);

    const fresh = await createFreePreview(serviceDeps(async () => doneRun()), { bytes: photo, ip: IP });
    if (fresh.kind !== "done") throw new Error("expected a preview");
    const late = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(await claimFreePreview(claimDeps(late), { previewId: fresh.previewId, userId: second.userId })).toEqual({
      kind: "refused",
      reason: "expired",
    });
    expect(
      await claimFreePreview(claimDeps(), { previewId: "00000000-0000-4000-8000-00000000dead", userId: second.userId }),
    ).toEqual({ kind: "refused", reason: "not_found" });
    expect(await claimFreePreview(claimDeps(), { previewId: "not-a-uuid", userId: second.userId })).toEqual({
      kind: "refused",
      reason: "not_found",
    });
  });

  it("refuses a blocked preview and a user without a workspace", async () => {
    const blocked = await createFreePreview(
      serviceDeps(async () => doneRun({ status: "blocked", reason: "no_product", main: null, preview: null })),
      { bytes: photo, ip: IP },
    );
    if (blocked.kind !== "blocked") throw new Error("expected a block");
    const owner = await newOwner();
    expect(await claimFreePreview(claimDeps(), { previewId: blocked.previewId, userId: owner.userId })).toEqual({
      kind: "refused",
      reason: "not_ready",
    });
    expect(
      await claimFreePreview(claimDeps(), { previewId, userId: "00000000-0000-4000-8000-00000000beef" }),
    ).toEqual({ kind: "refused", reason: "no_workspace" });
  });
});
