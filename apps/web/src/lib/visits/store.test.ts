import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteVisitSalts, siteVisits } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { sql, type Db } from "@curvi/db";

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { DbVisitStore, DAILY_PAGE_VIEW_CAP, getVisitStore, setVisitStoreForTests } = await import("./store");
const { recordVisit } = await import("./record");
const { loadVisitorStats, rangesFrom } = await import("./stats");

const IP = "203.0.113.77";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;

function asDb(): Db {
  return db as unknown as Db;
}

function beaconHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({ "user-agent": USER_AGENT, "x-forwarded-for": `${IP}, 10.0.0.1`, host: "curvi.ai", ...overrides });
}

async function visit(store: InstanceType<typeof DbVisitStore>, body: object, now: Date, headers = beaconHeaders()) {
  return recordVisit(store, { headers, body: JSON.stringify(body), siteHost: "curvi.ai", now });
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

beforeEach(async () => {
  await client.exec("delete from site_visits; delete from site_visit_salts;");
});

afterAll(async () => {
  await client.close();
});

describe("daily salt", () => {
  it("is made on demand, 64 hex characters, and shared by every instance for the day", async () => {
    const a = new DbVisitStore(asDb());
    const b = new DbVisitStore(asDb());
    const salt = await a.saltFor("2026-10-01");
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await b.saltFor("2026-10-01")).toBe(salt);
    const rows = await db.select().from(siteVisitSalts);
    expect(rows).toHaveLength(1);
  });

  it("rotates every UTC day and deletes salts older than yesterday", async () => {
    const store = new DbVisitStore(asDb());
    const first = await store.saltFor("2026-09-28");
    const second = await store.saltFor("2026-09-29");
    expect(second).not.toBe(first);
    await store.saltFor("2026-09-30");
    await store.saltFor("2026-10-01");
    const days = (await db.select({ day: siteVisitSalts.day }).from(siteVisitSalts)).map((r) => r.day).sort();
    expect(days).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("gives the same browser a new code on a new day, so days cannot be linked", async () => {
    const store = new DbVisitStore(asDb());
    await visit(store, { path: "/" }, new Date("2026-10-01T10:00:00Z"));
    await visit(store, { path: "/" }, new Date("2026-10-01T18:00:00Z"));
    await visit(store, { path: "/" }, new Date("2026-10-02T09:00:00Z"));
    const rows = await db.select({ day: siteVisits.day, hash: siteVisits.visitorHash }).from(siteVisits);
    const byDay = new Map<string, Set<string>>();
    for (const row of rows) {
      byDay.set(row.day, (byDay.get(row.day) ?? new Set()).add(row.hash));
    }
    expect(byDay.get("2026-10-01")?.size).toBe(1);
    expect(byDay.get("2026-10-02")?.size).toBe(1);
    expect([...(byDay.get("2026-10-01") ?? [])][0]).not.toBe([...(byDay.get("2026-10-02") ?? [])][0]);
  });
});

describe("recordVisit with the database store", () => {
  it("stores a cleaned page view and never the IP or the user agent", async () => {
    const store = new DbVisitStore(asDb());
    const outcome = await visit(
      store,
      {
        path: "/app/jobs/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d?tab=files",
        referrer: "https://www.google.com/search?q=curvi",
        utm_source: "Google",
        utm_medium: "cpc",
        utm_campaign: "Launch",
      },
      new Date("2026-10-01T12:00:00Z"),
    );
    expect(outcome).toEqual({ stored: true });
    const [row] = await db.select().from(siteVisits);
    expect(row).toMatchObject({
      day: "2026-10-01",
      path: "/app/jobs/:id",
      referrerHost: "google.com",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "launch",
      device: "desktop",
    });
    expect(row.visitorHash).toMatch(/^[0-9a-f]{32}$/);

    // Nothing in either table holds the IP or the user agent, whole or in part.
    const dump = await client.query<{ data: string }>(
      "select coalesce((select json_agg(v)::text from site_visits v), '') || coalesce((select json_agg(s)::text from site_visit_salts s), '') as data",
    );
    const text = dump.rows[0]?.data ?? "";
    expect(text).not.toContain(IP);
    expect(text).not.toContain("203.0.113");
    expect(text).not.toContain("Mozilla");
    expect(text).not.toContain("Chrome/141");
  });

  it("drops a referrer from this site and keeps other pages of the visit referrer free", async () => {
    const store = new DbVisitStore(asDb());
    await visit(store, { path: "/help", referrer: "https://curvi.ai/pricing" }, new Date("2026-10-01T12:00:00Z"));
    const [row] = await db.select().from(siteVisits);
    expect(row.referrerHost).toBeNull();
  });

  it("stores nothing for bots, prefetches, missing user agents and bad bodies", async () => {
    const store = new DbVisitStore(asDb());
    const now = new Date("2026-10-01T12:00:00Z");
    expect(await visit(store, { path: "/" }, now, beaconHeaders({ "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" }))).toEqual({
      stored: false,
      reason: "bot",
    });
    expect(await visit(store, { path: "/" }, now, beaconHeaders({ "sec-purpose": "prefetch" }))).toEqual({
      stored: false,
      reason: "prefetch",
    });
    const noAgent = beaconHeaders();
    noAgent.delete("user-agent");
    expect(await visit(store, { path: "/" }, now, noAgent)).toEqual({ stored: false, reason: "no_user_agent" });
    expect(await visit(store, { path: "https://evil.example/" }, now)).toEqual({ stored: false, reason: "invalid" });
    expect(await recordVisit(store, { headers: beaconHeaders(), body: "not json", siteHost: "curvi.ai", now })).toEqual({
      stored: false,
      reason: "invalid",
    });
    expect(await db.select().from(siteVisits)).toHaveLength(0);
    expect(await db.select().from(siteVisitSalts)).toHaveLength(0);
  });

  it("caps the page views stored per visitor and day", async () => {
    const cap = 3;
    const store = new DbVisitStore(asDb(), cap);
    const now = new Date("2026-10-01T12:00:00Z");
    const outcomes = [];
    for (let i = 0; i < cap + 2; i += 1) {
      outcomes.push(await visit(store, { path: `/page-${i}` }, now));
    }
    expect(outcomes.filter((o) => o.stored)).toHaveLength(cap);
    expect(outcomes.at(-1)).toEqual({ stored: false, reason: "capped" });
    expect(await db.select().from(siteVisits)).toHaveLength(cap);

    // The cap holds across instances: the database count is the one that counts.
    const other = new DbVisitStore(asDb(), cap);
    expect(await visit(other, { path: "/again" }, now)).toEqual({ stored: false, reason: "capped" });
    // Another visitor is not affected.
    expect(await visit(other, { path: "/" }, now, beaconHeaders({ "x-forwarded-for": "198.51.100.4" }))).toEqual({ stored: true });
    // Nor is the same visitor the next day.
    expect(await visit(store, { path: "/" }, new Date("2026-10-02T00:00:01Z"))).toEqual({ stored: true });
  });

  it("uses a cap of 500 by default", () => {
    expect(DAILY_PAGE_VIEW_CAP).toBe(500);
  });
});

describe("getVisitStore", () => {
  it("has no store without a database", () => {
    setVisitStoreForTests(undefined);
    expect(getVisitStore()).toBeNull();
  });
});

describe("loadVisitorStats", () => {
  it("adds daily visitors up over ranges and fills days with no visits", async () => {
    const insert = (day: string, hash: string, path: string, extra: Record<string, string | null> = {}) =>
      db.execute(sql`
        insert into site_visits (day, visitor_hash, path, referrer_host, utm_source, utm_campaign, device)
        values (${day}::date, ${hash}, ${path}, ${extra.referrer ?? null}, ${extra.source ?? null},
          ${extra.campaign ?? null}, ${extra.device ?? "desktop"})
      `);
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    // Today: two visitors, three page views.
    await insert("2026-10-01", a, "/", { referrer: "google.com", source: "newsletter", campaign: "launch" });
    await insert("2026-10-01", a, "/pricing");
    await insert("2026-10-01", b, "/", { device: "mobile" });
    // Yesterday: one visitor (the same person as today, with another code).
    await insert("2026-09-30", b, "/help", { device: "mobile" });
    // Ten days ago, and outside the 30 days.
    await insert("2026-09-21", a, "/");
    await insert("2026-08-01", a, "/old");

    const stats = await loadVisitorStats(asDb(), new Date("2026-10-01T15:00:00Z"));
    expect(stats.today).toBe("2026-10-01");
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily[0]?.day).toBe("2026-09-02");
    expect(stats.daily.at(-1)).toEqual({ day: "2026-10-01", visitors: 2, pageViews: 3 });
    expect(stats.daily.find((d) => d.day === "2026-09-25")).toEqual({ day: "2026-09-25", visitors: 0, pageViews: 0 });

    const ranges = Object.fromEntries(stats.ranges.map((r) => [r.key, { visitors: r.visitors, pageViews: r.pageViews }]));
    expect(ranges).toEqual({
      today: { visitors: 2, pageViews: 3 },
      yesterday: { visitors: 1, pageViews: 1 },
      last7: { visitors: 3, pageViews: 4 },
      last30: { visitors: 4, pageViews: 5 },
    });

    expect(stats.topPages[0]).toEqual({ label: "/", visitors: 3, pageViews: 3 });
    expect(stats.topPages.map((p) => p.label)).not.toContain("/old");
    expect(stats.topReferrers).toEqual([{ label: "google.com", visitors: 1, pageViews: 1 }]);
    expect(stats.topSources).toEqual([{ label: "newsletter", visitors: 1, pageViews: 1 }]);
    expect(stats.topCampaigns).toEqual([{ label: "launch", visitors: 1, pageViews: 1 }]);
    expect(Object.fromEntries(stats.devices.map((d) => [d.label, d.visitors]))).toEqual({ desktop: 2, mobile: 2 });
  });

  it("splits ranges from a daily series", () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, visitors: 1, pageViews: 2 }));
    expect(rangesFrom(daily).map((r) => [r.key, r.visitors, r.pageViews])).toEqual([
      ["today", 1, 2],
      ["yesterday", 1, 2],
      ["last7", 7, 14],
      ["last30", 30, 60],
    ]);
  });
});
