import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizedEmailKey, unsubscribeToken } from "@curvi/email";
import { MemorySuppressionStore, setSuppressionStoreForTests } from "@/lib/email/preferences";

// /api/email/unsubscribe (P18-06): the one click POST (RFC 8058), the page's
// POST, forged tokens, and the GET that lands on the confirm page.

vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { GET, POST } = await import("./route");

const SECRET = "unsubscribe-route-secret";
const KEY = normalizedEmailKey("seller@example.com") as string;
const TOKEN = unsubscribeToken(SECRET, KEY);
const BASE = "https://curvi.ai/api/email/unsubscribe";

let store: MemorySuppressionStore;

beforeEach(() => {
  store = new MemorySuppressionStore();
  setSuppressionStoreForTests(store);
  vi.stubEnv("CURVI_LINK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
});

afterEach(() => {
  setSuppressionStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("POST /api/email/unsubscribe", () => {
  it("accepts a mail app's one click POST as form data with the token in the URI", async () => {
    const response = await POST(
      new Request(`${BASE}?t=${encodeURIComponent(TOKEN)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
    expect(store.rows.get(KEY)).toEqual({ scope: "marketing", reason: "unsubscribed" });
  });

  it("accepts the one click POST as multipart/form-data", async () => {
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const response = await POST(new Request(`${BASE}?t=${encodeURIComponent(TOKEN)}`, { method: "POST", body: form }));
    expect(response.status).toBe(200);
    expect(store.rows.has(KEY)).toBe(true);
  });

  it("accepts the page's JSON body and a form field token", async () => {
    const json = await POST(
      new Request(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) }),
    );
    expect(json.status).toBe(200);
    store.rows.clear();
    const form = await POST(
      new Request(BASE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `t=${encodeURIComponent(TOKEN)}`,
      }),
    );
    expect(form.status).toBe(200);
    expect(store.rows.has(KEY)).toBe(true);
  });

  it("refuses a forged, foreign or missing token and stores nothing", async () => {
    const forged = unsubscribeToken("another-secret", KEY);
    for (const request of [
      new Request(`${BASE}?t=${encodeURIComponent(forged)}`, { method: "POST" }),
      new Request(`${BASE}?t=${encodeURIComponent(TOKEN.slice(0, -2))}`, { method: "POST" }),
      new Request(BASE, { method: "POST" }),
    ]) {
      const response = await POST(request);
      expect(response.status).toBe(400);
    }
    expect(store.rows.size).toBe(0);
  });

  it("refuses every token while no secret is set in db mode", async () => {
    vi.stubEnv("CURVI_LINK_SECRET", "");
    const response = await POST(new Request(`${BASE}?t=${encodeURIComponent(TOKEN)}`, { method: "POST" }));
    expect(response.status).toBe(400);
  });

  it("answers 503 when the list cannot be written", async () => {
    setSuppressionStoreForTests({
      add: async () => Promise.reject(new Error("db down")),
      scopeOf: async () => null,
      liftMarketing: async () => "none",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(new Request(`${BASE}?t=${encodeURIComponent(TOKEN)}`, { method: "POST" }));
    expect(response.status).toBe(503);
    spy.mockRestore();
  });
});

describe("GET /api/email/unsubscribe", () => {
  it("sends a browser to the confirm page without unsubscribing", async () => {
    const response = await GET(new Request(`${BASE}?t=${encodeURIComponent(TOKEN)}`, { headers: { host: "curvi.ai" } }));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin).toBe("https://curvi.ai");
    expect(location.pathname).toBe("/email/unsubscribe");
    expect(location.searchParams.get("t")).toBe(TOKEN);
    expect(store.rows.size).toBe(0);
  });
});
