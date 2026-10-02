/**
 * The first run answers on DbService against the real migrations in PGlite
 * (docs/phases/PHASE_18.md P18-20): saved on workspaces.seller_profile by
 * the owner connection for owners, admins and editors, never for a client
 * seat or another workspace's member, read back cleaned, and recorded as
 * the segment_answered funnel step.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events, members, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, type Db } from "@curvi/db";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn(async () => "inline") }));

import { DbService } from "./db";

const OWNER = "00000000-0000-4000-8000-000000002001";
const EDITOR = "00000000-0000-4000-8000-000000002002";
const CLIENT = "00000000-0000-4000-8000-000000002003";
const STRANGER = "00000000-0000-4000-8000-000000002004";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let ws: string;
let otherWs: string;

function serviceFor(user: string | null): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => user, getSupabase: async () => null });
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Candles" }).returning();
  const [o] = await db.insert(workspaces).values({ name: "Other" }).returning();
  ws = w.id;
  otherWs = o.id;
  await db.insert(members).values([
    { workspaceId: ws, userId: OWNER, role: "owner" },
    { workspaceId: ws, userId: EDITOR, role: "editor" },
    { workspaceId: ws, userId: CLIENT, role: "client" },
    { workspaceId: otherWs, userId: STRANGER, role: "owner" },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("DbService seller profile", () => {
  it("is null before any answer", async () => {
    expect(await serviceFor(OWNER).getSellerProfile(ws)).toBeNull();
  });

  it("saves the answer for the owner and records segment_answered", async () => {
    const saved = await serviceFor(OWNER).saveSellerProfile(ws, { category: "candles", channels: ["amazon", "shopify"] });
    expect(saved.ok).toBe(true);
    const profile = await serviceFor(OWNER).getSellerProfile(ws);
    expect(profile).toMatchObject({ category: "candles", channels: ["amazon", "shopify"] });
    expect(profile?.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ws), eq(events.name, "funnel.segment_answered")));
    expect(rows).toHaveLength(1);
    expect(rows[0].props).toEqual({ category: "candles", channels: "amazon,shopify", channel_count: 2 });
  });

  it("lets an editor change it, records nothing for an empty answer, and keeps it to the workspace", async () => {
    expect((await serviceFor(EDITOR).saveSellerProfile(ws, { category: "pet", channels: [] })).ok).toBe(true);
    expect(await serviceFor(EDITOR).getSellerProfile(ws)).toMatchObject({ category: "pet", channels: [] });
    await serviceFor(EDITOR).saveSellerProfile(ws, { category: null, channels: [] });
    const rows = await db.select().from(events).where(eq(events.name, "funnel.segment_answered"));
    expect(rows).toHaveLength(2);
    expect(await serviceFor(STRANGER).getSellerProfile(otherWs)).toBeNull();
  });

  it("refuses a client seat, another workspace's owner and a signed out caller", async () => {
    await serviceFor(OWNER).saveSellerProfile(ws, { category: "candles", channels: ["etsy"] });
    for (const user of [CLIENT, STRANGER, null]) {
      const result = await serviceFor(user).saveSellerProfile(ws, { category: "jewelry", channels: [] });
      expect(result, String(user)).toMatchObject({ ok: false, reason: "forbidden" });
    }
    expect(await serviceFor(OWNER).getSellerProfile(ws)).toMatchObject({ category: "candles", channels: ["etsy"] });
  });
});
