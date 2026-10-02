import type { Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETING_CONSENT_VERSION } from "@/lib/email/copy";
import { DbLeadStore, MemoryLeadStore, setLeadStoreForTests } from "@/lib/leads";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { jsonRequest } from "@/lib/testing/fake-services";

// The marketing consent box on lead capture (P18-06, founder decision 5):
// unticked means no consent, a tick records the first time and tool, and a
// later visit without the tick never clears it.

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");

const URL = "https://curvi.ai/api/leads";

describe("POST /api/leads with the consent box", () => {
  let store: MemoryLeadStore;

  beforeEach(() => {
    store = new MemoryLeadStore();
    setLeadStoreForTests(store);
    setRateLimitStoreForTests(new MemoryRateLimitStore());
  });

  afterEach(() => {
    setLeadStoreForTests(null);
    setRateLimitStoreForTests(null);
  });

  it("stores no consent when the box is left unticked or absent", async () => {
    await POST(jsonRequest(URL, { email: "a@example.com", source: "main-image-checker" }));
    await POST(jsonRequest(URL, { email: "b@example.com", source: "main-image-checker", marketingConsent: false }));
    expect(store.rows.get("a@example.com")?.marketingConsentAt).toBeUndefined();
    expect(store.rows.get("b@example.com")?.marketingConsentAt).toBeUndefined();
  });

  it("records a tick with its tool and keeps it on a later visit without one", async () => {
    await POST(jsonRequest(URL, { email: "c@example.com", source: "packs-paused", marketingConsent: true }));
    const first = store.rows.get("c@example.com");
    expect(first?.consentSource).toBe(`packs-paused@${MARKETING_CONSENT_VERSION}`);
    expect(first?.marketingConsentAt).toBeInstanceOf(Date);
    await POST(jsonRequest(URL, { email: "c@example.com", source: "main-image-checker" }));
    expect(store.rows.get("c@example.com")?.consentSource).toBe(`packs-paused@${MARKETING_CONSENT_VERSION}`);
  });

  it("refuses a post from another site's page, so no other site can enroll an address", async () => {
    const response = await POST(
      jsonRequest(URL, { email: "e@example.com", source: "main-image-checker", marketingConsent: true }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(store.rows.has("e@example.com")).toBe(false);
  });

  it("refuses a consent value that is not a boolean", async () => {
    const response = await POST(jsonRequest(URL, { email: "d@example.com", source: "gallery", marketingConsent: "yes" }));
    expect(response.status).toBe(400);
  });
});

describe("DbLeadStore consent columns", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  async function row(email: string) {
    return (
      await client.query<{ source: string; last_source: string | null; hits: number; marketing_consent_at: Date | null; consent_source: string | null }>(
        "select source, last_source, hits, marketing_consent_at, consent_source from leads where email = $1",
        [email],
      )
    ).rows[0];
  }

  it("writes consent only on a tick and never clears or moves it", async () => {
    const store = new DbLeadStore(db as unknown as Db);
    await store.save("lead@example.com", "main-image-checker");
    expect(await row("lead@example.com")).toMatchObject({ marketing_consent_at: null, consent_source: null });
    await store.save("lead@example.com", "store-audit", { marketingConsent: true });
    const ticked = await row("lead@example.com");
    expect(ticked).toMatchObject({ consent_source: `store-audit@${MARKETING_CONSENT_VERSION}`, last_source: "store-audit", hits: 2 });
    expect(ticked.marketing_consent_at).not.toBeNull();
    await store.save("lead@example.com", "white-background-fixer", { marketingConsent: true });
    await store.save("lead@example.com", "gallery");
    const later = await row("lead@example.com");
    expect(later).toMatchObject({ consent_source: `store-audit@${MARKETING_CONSENT_VERSION}`, hits: 4 });
    expect(later.marketing_consent_at).toEqual(ticked.marketing_consent_at);
  });

  it("records consent on a first visit with a tick", async () => {
    const store = new DbLeadStore(db as unknown as Db);
    await store.save("new@example.com", "packs-paused", { marketingConsent: true });
    expect(await row("new@example.com")).toMatchObject({ source: "packs-paused", consent_source: `packs-paused@${MARKETING_CONSENT_VERSION}` });
  });
});
