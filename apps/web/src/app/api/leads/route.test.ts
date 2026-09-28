import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLeadStore, setLeadStoreForTests } from "@/lib/leads";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { jsonRequest } from "@/lib/testing/fake-services";

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");

const URL = "https://curvi.ai/api/leads";
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

describe("POST /api/leads", () => {
  it("stores a normalized email once and bumps it on a repeat visit", async () => {
    const first = await POST(jsonRequest(URL, { email: "  Seller@Example.COM ", source: "main-image-checker" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    await POST(jsonRequest(URL, { email: "seller@example.com", source: "marketplace-resizer" }));
    expect(store.rows.get("seller@example.com")).toEqual({
      source: "main-image-checker",
      lastSource: "marketplace-resizer",
      hits: 2,
    });
  });

  it("refuses an invalid email with plain copy", async () => {
    const response = await POST(jsonRequest(URL, { email: "not an email", source: "main-image-checker" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Enter a valid email address.");
    expect(store.rows.size).toBe(0);
  });

  it("refuses an unknown source", async () => {
    const response = await POST(jsonRequest(URL, { email: "a@example.com", source: "somewhere" }));
    expect(response.status).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it("refuses a body that is not JSON or is too large", async () => {
    const notJson = await POST(
      new Request(URL, { method: "POST", headers: { "x-forwarded-for": "203.0.113.10" }, body: "email=a" }),
    );
    expect(notJson.status).toBe(400);
    const huge = await POST(jsonRequest(URL, { email: "a@example.com", source: "gallery", pad: "x".repeat(4000) }));
    expect(huge.status).toBe(413);
  });

  it("answers a filled honeypot like a success but stores nothing", async () => {
    const response = await POST(
      jsonRequest(URL, { email: "bot@example.com", source: "main-image-checker", website: "https://spam.example" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(store.rows.size).toBe(0);
  });

  it("answers 429 by IP once the limit is spent", async () => {
    const { limit } = RATE_LIMIT_POLICIES["leads.create"].ip;
    for (let i = 0; i < limit; i += 1) {
      const ok = await POST(jsonRequest(URL, { email: `a${i}@example.com`, source: "gallery" }));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(jsonRequest(URL, { email: "late@example.com", source: "gallery" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(store.rows.has("late@example.com")).toBe(false);
  });

  it("answers 503 when the store fails, without echoing the email", async () => {
    const failing = { save: vi.fn(async () => Promise.reject(new Error("db down"))) };
    setLeadStoreForTests(failing);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(jsonRequest(URL, { email: "a@example.com", source: "gallery" }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("a@example.com");
    spy.mockRestore();
  });
});
