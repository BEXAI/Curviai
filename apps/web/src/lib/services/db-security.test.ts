import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandKits, creditLedger, members, products, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import type { BrandKitView } from "./types";

// Update.md 4.1 and 4.2 on the service side: brand kit writes check the role
// and the logo key and run over the owner connection, getBrandKit never signs
// a foreign key, and createJob only hands source keys from this workspace's
// source prefix to the worker.

const enqueued: GeneratePackInput[] = [];
vi.mock("@/lib/jobs/enqueue", () => ({
  enqueueGeneratePack: vi.fn(async (payload: GeneratePackInput) => {
    enqueued.push(payload);
    return "inline";
  }),
}));

const { DbService } = await import("./db");

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const EDITOR = "00000000-0000-4000-8000-0000000000e2";
const CLIENT = "00000000-0000-4000-8000-0000000000e3";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let otherWs: string;
let currentUser = OWNER;

function service() {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => currentUser,
    // Brand kit writes must not depend on the Supabase client any more.
    getSupabase: async () => null,
  });
}

function kit(overrides: Partial<BrandKitView> = {}): BrandKitView {
  return {
    name: "House style",
    colors: ["#1D2433", "#FD7F11"],
    fonts: { heading: "Inter", body: "Inter" },
    stylePreset: "minimal_studio",
    hasLogo: false,
    logoKey: null,
    ...overrides,
  };
}

async function kitRow() {
  return db.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, ws) });
}

// Simulates a row written before migration 0011: its NOT VALID constraints
// only check new writes, so drop, write, then re add exactly as 0011 does.
async function withoutPrefixChecks(table: "brand_kits" | "source_media", write: () => Promise<unknown>) {
  const [name, column] =
    table === "brand_kits"
      ? ["brand_kits_logo_r2_key_workspace_prefix", "logo_r2_key IS NULL OR starts_with(logo_r2_key, 'ws/' || workspace_id::text || '/')"]
      : ["source_media_r2_key_workspace_prefix", "starts_with(r2_key, 'ws/' || workspace_id::text || '/')"];
  await client.exec(`alter table ${table} drop constraint ${name}`);
  try {
    await write();
  } finally {
    await client.exec(`alter table ${table} add constraint ${name} check (${column}) not valid`);
  }
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Brand", plan: "starter" }).returning();
  const [o] = await db.insert(workspaces).values({ name: "Other" }).returning();
  ws = w.id;
  otherWs = o.id;
  await db.insert(members).values([
    { workspaceId: ws, userId: OWNER, role: "owner" },
    { workspaceId: ws, userId: EDITOR, role: "editor" },
    { workspaceId: ws, userId: CLIENT, role: "client" },
  ]);
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 500, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  currentUser = OWNER;
  enqueued.length = 0;
});

describe("DbService.saveBrandKit (Update.md 4.2)", () => {
  it("rejects the client role before writing anything", async () => {
    currentUser = CLIENT;
    const result = await service().saveBrandKit(ws, kit());
    expect(result.ok).toBe(false);
    expect(result.notice).toBe("Only owners, admins and editors can change the brand kit.");
    expect(await kitRow()).toBeUndefined();
  });

  it("rejects a non member", async () => {
    currentUser = "00000000-0000-4000-8000-0000000000ff";
    expect((await service().saveBrandKit(ws, kit())).ok).toBe(false);
  });

  it.each([
    ["another workspace's key", () => `ws/${otherWs}/src/logo.png`],
    ["an output key in this workspace", () => `ws/${ws}/jobs/j/files/amazon/main.jpg`],
    ["a traversal key", () => `ws/${ws}/src/../../${otherWs}/src/logo.png`],
    ["a key outside any workspace", () => "logos/logo.png"],
  ])("rejects %s as the logo", async (_label, key) => {
    const result = await service().saveBrandKit(ws, kit({ logoKey: key() }));
    expect(result.ok).toBe(false);
    expect(result.notice).toBe("That logo upload does not belong to this workspace. Upload it again.");
    expect(await kitRow()).toBeUndefined();
  });

  it("rejects an unknown style preset and too many colors", async () => {
    expect((await service().saveBrandKit(ws, kit({ stylePreset: "neon_rave" }))).notice).toBe(
      "Pick a style preset from the list.",
    );
    const colors = Array.from({ length: 7 }, () => "#000000");
    expect((await service().saveBrandKit(ws, kit({ colors }))).ok).toBe(false);
    expect((await service().saveBrandKit(ws, kit({ colors: ["red"] }))).ok).toBe(false);
  });

  it("lets an editor create and then update the kit over the owner connection", async () => {
    currentUser = EDITOR;
    const logo = `ws/${ws}/src/logo.png`;
    const first = await service().saveBrandKit(ws, kit({ logoKey: logo }));
    expect(first).toEqual({ ok: true, notice: "Brand kit saved." });
    expect((await kitRow())?.logoR2Key).toBe(logo);

    // The update used to go through the Supabase client; with no client at
    // all it must still land.
    const second = await service().saveBrandKit(ws, kit({ name: "Renamed", logoKey: null }));
    expect(second.ok).toBe(true);
    const row = await kitRow();
    expect(row?.name).toBe("Renamed");
    expect(row?.logoR2Key).toBe(logo);
  });

  it("drops a legacy foreign logo key instead of keeping or signing it", async () => {
    await withoutPrefixChecks("brand_kits", () =>
      db.update(brandKits).set({ logoR2Key: `ws/${otherWs}/src/stolen.png` }).where(eq(brandKits.workspaceId, ws)),
    );

    const view = await service().getBrandKit(ws);
    expect(view.logoKey).toBeNull();
    expect(view.logoUrl).toBeNull();
    expect(view.hasLogo).toBe(false);

    const saved = await service().saveBrandKit(ws, kit({ logoKey: view.logoKey }));
    expect(saved.ok).toBe(true);
    expect((await kitRow())?.logoR2Key).toBeNull();
  });

  it("returns an own workspace logo key and normalizes an unknown preset", async () => {
    await db
      .update(brandKits)
      .set({ logoR2Key: `ws/${ws}/src/logo.png`, stylePreset: "retired_preset" })
      .where(eq(brandKits.workspaceId, ws));
    const view = await service().getBrandKit(ws);
    expect(view.logoKey).toBe(`ws/${ws}/src/logo.png`);
    expect(view.hasLogo).toBe(true);
    expect(view.stylePreset).toBe("minimal_studio");
  });
});

describe("DbService.createJob source media read filter (Update.md 4.1)", () => {
  it("never hands the worker a key outside this workspace's source prefix", async () => {
    const [product] = await db.insert(products).values({ workspaceId: ws, title: "Kettle", mode: "listing" }).returning();
    // Legacy rows a member could have written before 0011.
    await db.insert(sourceMedia).values({
      workspaceId: ws,
      productId: product.id,
      r2Key: `ws/${ws}/jobs/j/files/amazon/main.jpg`,
      kind: "image",
      sha256: "c".repeat(64),
    });
    await withoutPrefixChecks("source_media", () =>
      db.insert(sourceMedia).values({
        workspaceId: ws,
        productId: product.id,
        r2Key: `ws/${otherWs}/src/secret.jpg`,
        kind: "image",
        sha256: "d".repeat(64),
      }),
    );

    const rejected = await service().createJob(ws, {
      productId: product.id,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: "media-filter-1",
    });
    expect(rejected).toMatchObject({ outcome: "rejected", reason: "needs_photo" });
    expect(enqueued).toHaveLength(0);

    const own = `ws/${ws}/src/real-photo.jpg`;
    await db.insert(sourceMedia).values({
      workspaceId: ws,
      productId: product.id,
      r2Key: own,
      kind: "image",
      sha256: "e".repeat(64),
    });
    const created = await service().createJob(ws, {
      productId: product.id,
      channels: ["amazon.main"],
      mode: "listing",
      idempotencyKey: "media-filter-2",
    });
    expect(created.outcome).toBe("created");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].images.map((image) => image.mediaId)).toEqual([own]);
  });
});
