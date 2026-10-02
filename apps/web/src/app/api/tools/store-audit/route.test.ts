import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeAudit } from "@curvi/pipeline/seed";
import { storeAuditErrors } from "@/components/marketing/search-copy";
import { mainImagePng } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { jsonRequest } from "@/lib/testing/fake-services";
import type { SafeFetchOptions, SafeFetchResult } from "@/lib/url-import/safe-fetch";

const state = vi.hoisted(() => ({ enabled: true, dbMode: false }));
const funnel = vi.hoisted(() => ({ calls: [] as unknown[] }));
const challenge = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/turnstile", async (original) => ({
  ...(await original<typeof import("@/lib/turnstile")>()),
  verifyTurnstile: challenge.verify,
}));

vi.mock("@/lib/store-audit/switch", () => ({
  storeAuditEnabled: async () => state.enabled,
}));
vi.mock("@/lib/services", () => ({
  getServices: () => {
    throw new Error("the store audit needs no services");
  },
  isDbMode: () => state.dbMode,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@curvi/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@curvi/db")>()),
  recordFunnelEvent: async (_db: unknown, input: unknown) => {
    funnel.calls.push(input);
    return { recorded: true, firstRecorded: false };
  },
}));
// The network edge: every outside fetch the audit makes goes through here.
const safeFetchMock = vi.fn<(url: string | URL, options: SafeFetchOptions) => Promise<SafeFetchResult>>();
vi.mock("@/lib/url-import/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-import/safe-fetch")>()),
  safeFetch: (url: string | URL, options: SafeFetchOptions) => safeFetchMock(url, options),
}));

const { POST } = await import("./route");

const URL_ = "http://localhost/api/tools/store-audit";
const LIST_URL = `https://candles.example.com/products.json?limit=${storeAudit.maxProducts}`;
const IMAGE = "https://cdn.shopify.com/front.png";

let png: Buffer;

beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  challenge.verify.mockReset().mockResolvedValue(false);
  state.enabled = true;
  state.dbMode = false;
  funnel.calls = [];
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  png ??= await mainImagePng(2000, 0.87);
  safeFetchMock.mockReset();
  safeFetchMock.mockImplementation(async (url) => {
    const href = url.toString();
    if (href === LIST_URL) {
      const body = JSON.stringify({ products: [{ title: "Candle", handle: "candle", images: [{ src: IMAGE, position: 1 }] }] });
      return { status: 200, contentType: "application/json", body: Buffer.from(body), url: new URL(href) };
    }
    if (href === IMAGE) {
      return { status: 200, contentType: "image/png", body: png, url: new URL(href) };
    }
    return { status: 404, contentType: "text/html", body: Buffer.alloc(0), url: new URL(href) };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setRateLimitStoreForTests(null);
});

function audit(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(jsonRequest(URL_, body, headers));
}

describe("POST /api/tools/store-audit", () => {
  it("fetches no store or image until the store-audit challenge passes", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect((await audit({ store: "candles.example.com" })).status).toBe(403);
    expect(safeFetchMock).not.toHaveBeenCalled();
    challenge.verify.mockResolvedValue(true);
    expect((await audit({ store: "candles.example.com", captchaToken: "signed-token" })).status).toBe(200);
    expect(challenge.verify).toHaveBeenLastCalledWith("signed-token", {
      action: "store-audit", hostname: "localhost", ip: "203.0.113.10",
    });
  });

  it("fails closed on partial configuration without fetching or spending quota", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect((await audit({ store: "candles.example.com" })).status).toBe(503);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(challenge.verify).not.toHaveBeenCalled();
  });

  it("allows only the fallback production audit allowance for each IP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await audit({ store: "candles.example.com" })).status).toBe(200);
    const limited = await audit({ store: "candles.example.com" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect((await audit({ store: "candles.example.com" }, { "x-forwarded-for": "198.51.100.7" })).status).toBe(200);
  });

  it("answers 404 and fetches nothing while the switch is off", async () => {
    state.enabled = false;
    const response = await audit({ store: "candles.example.com" });
    expect(response.status).toBe(404);
    expect((await response.json()).reason).toBe("off");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("audits a store and returns the report", async () => {
    const response = await audit({ store: "https://candles.example.com/collections/all", channel: "google" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { audit: report } = await response.json();
    expect(report.store).toBe("candles.example.com");
    expect(report.channel.key).toBe("google");
    expect(report.summary).toMatchObject({ listed: 1, checked: 1, failing: 0, thin: 1 });
    expect(report.products[0]).toMatchObject({ title: "Candle", url: "https://candles.example.com/products/candle", imageCount: 1 });
  });

  it("records the funnel event with counts only, never the store's address", async () => {
    state.dbMode = true;
    expect((await audit({ store: "candles.example.com" })).status).toBe(200);
    expect(funnel.calls).toEqual([
      {
        workspaceId: null,
        name: "store_audit_run",
        props: { channel: "amazon", listed: 1, checked: 1, failing: 0, thin: 1, not_checked: 0 },
      },
    ]);
    expect(JSON.stringify(funnel.calls)).not.toContain("candles");
    // A refused audit records nothing.
    await audit({ store: "notshopify.example.com" });
    expect(funnel.calls).toHaveLength(1);
  });

  it("falls back to Amazon for an unknown channel", async () => {
    const response = await audit({ store: "candles.example.com", channel: "nowhere" });
    expect((await response.json()).audit.channel.key).toBe("amazon");
  });

  it.each([
    [{}, "invalid_store"],
    [{ store: "" }, "invalid_store"],
    [{ store: 42 }, "invalid_store"],
    [{ store: "localhost" }, "blocked_host"],
    [{ store: "https://10.0.0.5/" }, "blocked_host"],
    [{ store: "amazon.com" }, "amazon"],
  ])("refuses %o with 400 %s and fetches nothing", async (body, reason) => {
    const response = await audit(body);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.reason).toBe(reason);
    expect(payload.error).toBe(storeAuditErrors[reason as keyof typeof storeAuditErrors]);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("refuses a cross site request", async () => {
    const response = await audit({ store: "candles.example.com" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body over the cap", async () => {
    const response = await audit({ store: "candles.example.com", pad: "x".repeat(5000) });
    expect(response.status).toBe(413);
  });

  it("limits audits per IP to the seeded number an hour, and invalid addresses use none of it", async () => {
    const { limit } = RATE_LIMIT_POLICIES["tools.storeAudit"].ip;
    expect(limit).toBe(storeAudit.auditsPerIpPerHour);
    await audit({ store: "localhost" });
    for (let index = 0; index < limit; index += 1) {
      expect((await audit({ store: "candles.example.com" })).status).toBe(200);
    }
    const limited = await audit({ store: "candles.example.com" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another address still has its own allowance.
    expect((await audit({ store: "candles.example.com" }, { "x-forwarded-for": "198.51.100.7" })).status).toBe(200);
  });

  it("stops every visitor once the site wide daily cap is reached", async () => {
    // Use up the day without running audits.
    const { takeDailyAudit } = await import("@/lib/store-audit/daily-cap");
    for (let index = 0; index < storeAudit.auditsPerDay; index += 1) {
      expect((await takeDailyAudit()).allowed).toBe(true);
    }
    const response = await audit({ store: "candles.example.com" }, { "x-forwarded-for": "198.51.100.9" });
    expect(response.status).toBe(429);
    expect((await response.json()).reason).toBe("daily_cap");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("answers busy when the process already runs the seeded number of audits", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    safeFetchMock.mockImplementation(async (url) => {
      await gate;
      return { status: 404, contentType: "text/html", body: Buffer.alloc(0), url: new URL(url.toString()) };
    });
    const running = Array.from({ length: storeAudit.concurrentAudits }, (_, index) =>
      audit({ store: "candles.example.com" }, { "x-forwarded-for": `198.51.100.${20 + index}` }),
    );
    await vi.waitFor(() => expect(safeFetchMock).toHaveBeenCalledTimes(storeAudit.concurrentAudits));
    const busy = await audit({ store: "candles.example.com" }, { "x-forwarded-for": "198.51.100.40" });
    expect(busy.status).toBe(503);
    expect((await busy.json()).reason).toBe("busy");
    release();
    for (const response of await Promise.all(running)) {
      expect(response.status).toBe(422);
    }
    // The slots are free again.
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue({ status: 404, contentType: "text/html", body: Buffer.alloc(0), url: new URL(LIST_URL) });
    expect((await audit({ store: "candles.example.com" }, { "x-forwarded-for": "198.51.100.41" })).status).toBe(422);
  });

  it("answers a store that is not Shopify with 422", async () => {
    const response = await audit({ store: "notshopify.example.com" });
    expect(response.status).toBe(422);
    expect((await response.json()).reason).toBe("not_shopify");
  });
});
