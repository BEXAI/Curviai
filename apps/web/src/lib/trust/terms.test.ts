import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { members, termsAcceptances, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { recordTermsAcceptance, resetTermsCacheForTests, TERMS_VERSION } from "./terms";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;

function nextUser(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(700 + counter).padStart(12, "0")}`;
}

function headers(ip?: string): Headers {
  const h = new Headers({ "user-agent": "Mozilla/5.0 test" });
  if (ip) {
    h.set("x-forwarded-for", ip);
  }
  return h;
}

async function rowsFor(userId: string) {
  return db.select().from(termsAcceptances).where(eq(termsAcceptances.userId, userId));
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

beforeEach(() => {
  resetTermsCacheForTests();
});

afterAll(async () => {
  await client.close();
});

describe("recordTermsAcceptance", () => {
  it("records the version, the server time, the IP, the user agent and the workspace once", async () => {
    const user = nextUser();
    const [ws] = await db.insert(workspaces).values({ name: "Terms" }).returning();
    await db.insert(members).values({ workspaceId: ws.id, userId: user, role: "owner" });
    const before = Date.now();
    const input = { userId: user, source: "signup_callback" as const, headers: headers("203.0.113.9") };
    expect(await recordTermsAcceptance(db as unknown as Db, input)).toBe(true);
    const [row] = await rowsFor(user);
    expect(row).toMatchObject({
      version: TERMS_VERSION,
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 test",
      source: "signup_callback",
      workspaceId: ws.id,
    });
    expect(row.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    resetTermsCacheForTests();
    expect(await recordTermsAcceptance(db as unknown as Db, { ...input, source: "first_app_visit" })).toBe(false);
    expect(await rowsFor(user)).toHaveLength(1);
  });

  it("never records a newer version over an existing record", async () => {
    const user = nextUser();
    await db.insert(termsAcceptances).values({ userId: user, version: "2020-01-01", source: "signup_callback" });
    expect(
      await recordTermsAcceptance(db as unknown as Db, { userId: user, source: "first_app_visit", headers: headers() }),
    ).toBe(false);
    expect((await rowsFor(user)).map((r) => r.version)).toEqual(["2020-01-01"]);
  });

  it("stores no IP when the request has none", async () => {
    const user = nextUser();
    await recordTermsAcceptance(db as unknown as Db, { userId: user, source: "first_app_visit", headers: headers() });
    const [row] = await rowsFor(user);
    expect(row).toMatchObject({ ip: null, workspaceId: null });
  });

  it("does not record an unauthenticated Cloudflare header as the request IP", async () => {
    const user = nextUser();
    const requestHeaders = headers();
    requestHeaders.set("cf-connecting-ip", "203.0.113.99");
    await recordTermsAcceptance(db as unknown as Db, { userId: user, source: "first_app_visit", headers: requestHeaders });
    expect((await rowsFor(user))[0].ip).toBeNull();
  });

  it("skips the database once a user is known to have a record", async () => {
    const user = nextUser();
    await recordTermsAcceptance(db as unknown as Db, { userId: user, source: "first_app_visit", headers: headers() });
    const failing = {
      execute: () => {
        throw new Error("should not be called");
      },
    } as unknown as Db;
    expect(await recordTermsAcceptance(failing, { userId: user, source: "first_app_visit", headers: headers() })).toBe(false);
  });
});

describe("TERMS_VERSION", () => {
  // The terms page prints LEGAL_FACTS.termsLastUpdated as its Last updated
  // date; lib/legal/pages.test.ts checks the rendered page.
  it("is the Last updated date of the terms page", () => {
    expect(LEGAL_FACTS.termsLastUpdated).toBe(TERMS_VERSION);
  });
});
