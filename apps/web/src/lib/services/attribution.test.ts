/**
 * The callback's attribution write (docs/phases/PHASE_18.md P18-01) and the
 * funnel.signup_confirmed step (P18-02) against the real migrations: one
 * row per user from the signup metadata, a second confirmation writes
 * nothing, bad metadata is dropped, never stored, and Google's attr
 * parameter works the same way.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events, members, signupAttributions, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { encodeAttributionParam } from "@/lib/attribution";
import { attributionFromUser, getSignupAttribution, recordSignupConfirmed, signupMethodOf } from "./attribution";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const NOW = new Date("2026-10-05T12:00:00.000Z");

async function newUser(n: number): Promise<{ userId: string; ws: string }> {
  const userId = `00000000-0000-4000-8000-0000000019${String(n).padStart(2, "0")}`;
  const [w] = await db.insert(workspaces).values({ name: `ws ${n}` }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId, role: "owner" });
  return { userId, ws: w.id };
}

async function confirmedEvents(ws: string | null) {
  const rows = await db.select().from(events);
  return rows.filter((row) => row.name === "funnel.signup_confirmed" && row.workspaceId === ws);
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("recordSignupConfirmed", () => {
  it("stores the cleaned hint once and counts the signup once", async () => {
    const { userId, ws } = await newUser(1);
    const user = {
      id: userId,
      user_metadata: {
        terms_accepted_at: "2026-10-05T11:59:00Z",
        signup_source: "pricing",
        attribution: {
          source: "home",
          utm_source: "Reddit",
          utm_campaign: "label_test",
          referrer_host: "reddit.com",
          landing_path: "/?utm_source=reddit",
          first_seen_at: "2026-10-04T08:00:00Z",
          self_reported: "reddit",
          consent: "granted",
        },
      },
      app_metadata: { provider: "email" },
    };
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: null, now: NOW })).toBe("written");
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: null, now: NOW })).toBe("already_recorded");

    const rows = await db.select().from(signupAttributions).where(eq(signupAttributions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: ws,
      source: "home",
      utmSource: "reddit",
      utmCampaign: "label_test",
      referrerHost: "reddit.com",
      landingPath: "/",
      selfReported: "reddit",
      consent: "granted",
      method: "email",
    });
    expect(rows[0].firstSeenAt?.toISOString()).toBe("2026-10-04T08:00:00.000Z");

    const confirmed = await confirmedEvents(ws);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].props).toEqual({
      method: "email",
      source: "home",
      self_reported: "reddit",
      utm_source: "reddit",
      utm_campaign: "label_test",
      consent: "granted",
    });
    expect(await getSignupAttribution(db as unknown as Db, ws)).toMatchObject({ userId, source: "home" });
  });

  it("drops metadata that is not a flat object of short strings, keeping the legacy source", async () => {
    const { userId } = await newUser(2);
    const user = {
      id: userId,
      user_metadata: {
        signup_source: "pricing",
        attribution: { utm_source: "x".repeat(600), nested: { evil: true } },
      },
    };
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: null, now: NOW })).toBe("written");
    const [row] = await db.select().from(signupAttributions).where(eq(signupAttributions.userId, userId));
    expect(row).toMatchObject({ source: "pricing", utmSource: null, selfReported: null, consent: null });
  });

  it("reads Google's attr parameter when the metadata has no hint", async () => {
    const { userId } = await newUser(3);
    const attr = encodeAttributionParam({ source: "header", utm_source: "tiktok", self_reported: "tiktok", consent: "denied" });
    const user = { id: userId, user_metadata: {}, app_metadata: { provider: "google" } };
    expect(signupMethodOf(user)).toBe("google");
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: attr, now: NOW })).toBe("written");
    const [row] = await db.select().from(signupAttributions).where(eq(signupAttributions.userId, userId));
    expect(row).toMatchObject({ source: "header", utmSource: "tiktok", selfReported: "tiktok", consent: "denied", method: "google" });
  });

  it("never stores a prospect claim token, only the share and preview it came with", async () => {
    // P18-04: the raw token claims the pack and takes its page down, and
    // owners and admins can read this row; redeeming writes the claim's id.
    const { userId } = await newUser(4);
    const token = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const user = { id: userId, user_metadata: { attribution: { source: "concierge", claim: token, s: "fernwick" } } };
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: null, now: NOW })).toBe("written");
    const [row] = await db.select().from(signupAttributions).where(eq(signupAttributions.userId, userId));
    expect(row).toMatchObject({ source: "concierge", shareSlug: "fernwick", claimId: null });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("counts a signup with no workspace yet without a row", async () => {
    const user = { id: "00000000-0000-4000-8000-000000001999", user_metadata: { attribution: { source: "help" } } };
    const before = (await confirmedEvents(null)).length;
    expect(await recordSignupConfirmed(db as unknown as Db, { user, attrParam: null, now: NOW })).toBe("no_workspace");
    expect(await db.select().from(signupAttributions).where(eq(signupAttributions.userId, user.id))).toHaveLength(0);
    expect((await confirmedEvents(null)).length).toBe(before + 1);
  });

  it("never throws when the database fails", async () => {
    const broken = {
      execute: () => Promise.reject(new Error("connection refused")),
      insert: () => {
        throw new Error("connection refused");
      },
    } as unknown as Db;
    const log = { error: vi.fn() };
    const user = { id: "00000000-0000-4000-8000-000000001998", user_metadata: {} };
    expect(await recordSignupConfirmed(broken, { user, attrParam: null, now: NOW }, log)).toBe("failed");
    expect(log.error).toHaveBeenCalled();
  });
});

describe("attributionFromUser", () => {
  it("prefers the metadata hint over the attr parameter", () => {
    const attr = encodeAttributionParam({ source: "gallery" });
    expect(attributionFromUser({ id: "u", user_metadata: { attribution: { source: "help" } } }, attr, NOW)).toEqual({
      source: "help",
      consent: null,
    });
  });
});
