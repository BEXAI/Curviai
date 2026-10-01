import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { PageViewRow, RecordResult, VisitStore } from "@/lib/visits/store";

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");
const { setVisitStoreForTests } = await import("@/lib/visits/store");

const URL = "http://localhost:3000/api/visits";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const KEY = "route-test-key-0123456789abcdef0123456789";

class FakeStore implements VisitStore {
  rows: PageViewRow[] = [];
  fail = false;
  saltFor = vi.fn(async (_day: string) => "ab".repeat(32));
  knows(day: string, visitorHash: string): boolean {
    return this.rows.some((row) => row.day === day && row.visitorHash === visitorHash);
  }
  async record(view: PageViewRow): Promise<RecordResult> {
    if (this.fail) {
      throw new Error("database is down");
    }
    this.rows.push(view);
    return "stored";
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let store: FakeStore;

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "sec-fetch-site": "same-origin",
      "user-agent": BROWSER,
      "x-forwarded-for": "203.0.113.20",
      "content-type": "text/plain;charset=UTF-8",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectEmpty204(response: Response): Promise<void> {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(response.headers.get("set-cookie")).toBeNull();
}

beforeEach(() => {
  store = new FakeStore();
  setVisitStoreForTests(store);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("VISITS_HASH_KEY", KEY);
});

afterEach(() => {
  setVisitStoreForTests(undefined);
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/visits", () => {
  it("stores a page view from this site and answers an empty 204", async () => {
    await expectEmpty204(await POST(beacon({ path: "/pricing?x=1", utm_source: "Newsletter" })));
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ path: "/pricing", utmSource: "newsletter", device: "desktop" });
    expect(store.rows[0]?.visitorHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(store.rows)).not.toContain("203.0.113.20");
  });

  it("refuses a request from another site, still with a 204", async () => {
    await expectEmpty204(await POST(beacon({ path: "/" }, { origin: "https://evil.example" })));
    await expectEmpty204(await POST(beacon({ path: "/" }, { origin: "null" })));
    await expectEmpty204(await POST(beacon({ path: "/" }, { "sec-fetch-site": "cross-site" })));
    expect(store.rows).toHaveLength(0);
    expect(store.saltFor).not.toHaveBeenCalled();
  });

  it("ignores bots, prefetches and requests with no user agent", async () => {
    await expectEmpty204(
      await POST(beacon({ path: "/" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })),
    );
    await expectEmpty204(
      await POST(beacon({ path: "/" }, { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/141.0.0.0 Safari/537.36" })),
    );
    await expectEmpty204(await POST(beacon({ path: "/" }, { purpose: "prefetch" })));
    await expectEmpty204(await POST(beacon({ path: "/" }, { "sec-purpose": "prefetch;prerender" })));
    await expectEmpty204(await POST(beacon({ path: "/" }, { "user-agent": "" })));
    expect(store.rows).toHaveLength(0);
    expect(store.saltFor).not.toHaveBeenCalled();
  });

  it("answers 204 to a bad or oversized body and stores nothing", async () => {
    await expectEmpty204(await POST(beacon("not json")));
    await expectEmpty204(await POST(beacon({ nope: true })));
    await expectEmpty204(await POST(beacon({ path: "https://evil.example/" })));
    await expectEmpty204(await POST(beacon({ path: "/", pad: "x".repeat(10_000) })));
    expect(store.rows).toHaveLength(0);
  });

  it("answers 204 when the store fails, and the error never reaches the visitor", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.fail = true;
    await expectEmpty204(await POST(beacon({ path: "/" })));
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).not.toContain("203.0.113.20");
  });

  it("answers 204 without a database and stores nothing", async () => {
    setVisitStoreForTests(undefined);
    await expectEmpty204(await POST(beacon({ path: "/" })));
  });

  it("does not wait on a slow database past its time limit", async () => {
    vi.useFakeTimers();
    const slow = deferred<string>();
    try {
      store.saltFor.mockImplementation(() => slow.promise);
      const pending = POST(beacon({ path: "/" }));
      await vi.advanceTimersByTimeAsync(3000);
      await expectEmpty204(await pending);
    } finally {
      // Let the work end so it gives its slot back.
      slow.resolve("ab".repeat(32));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("stores nothing without VISITS_HASH_KEY, or with one too short to be a secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("VISITS_HASH_KEY", "");
    await expectEmpty204(await POST(beacon({ path: "/" })));
    vi.stubEnv("VISITS_HASH_KEY", "short-key");
    await expectEmpty204(await POST(beacon({ path: "/" })));
    expect(store.rows).toHaveLength(0);
    expect(store.saltFor).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not count the operator pages", async () => {
    await expectEmpty204(await POST(beacon({ path: "/app/ops/visitors" })));
    expect(store.rows).toHaveLength(0);
  });

  it("counts at most the per IP hourly limit of page views, and still answers 204", async () => {
    const { limit } = RATE_LIMIT_POLICIES["visits.record"].ip;
    expect(limit).toBe(300);
    for (let i = 0; i < limit + 1; i += 1) {
      await expectEmpty204(await POST(beacon({ path: `/page-${i}` })));
    }
    expect(store.rows).toHaveLength(limit);
    // Another address is not affected.
    await expectEmpty204(await POST(beacon({ path: "/" }, { "x-forwarded-for": "198.51.100.9" })));
    expect(store.rows).toHaveLength(limit + 1);
  });

  it("makes at most 30 new visitors an hour from one IP that changes its user agent every time", async () => {
    const { limit } = RATE_LIMIT_POLICIES["visits.newVisitor"].ip;
    expect(limit).toBe(30);
    for (let i = 0; i < limit + 10; i += 1) {
      await expectEmpty204(await POST(beacon({ path: "/" }, { "user-agent": `${BROWSER} r=${i}` })));
    }
    expect(store.rows).toHaveLength(limit);
    expect(new Set(store.rows.map((row) => row.visitorHash)).size).toBe(limit);
    // Visitors already counted keep counting.
    await expectEmpty204(await POST(beacon({ path: "/pricing" }, { "user-agent": `${BROWSER} r=0` })));
    expect(store.rows).toHaveLength(limit + 1);
    // So does a person at another address.
    await expectEmpty204(await POST(beacon({ path: "/" }, { "x-forwarded-for": "198.51.100.9" })));
    expect(store.rows).toHaveLength(limit + 2);
  });

  it("works on at most 3 beacons at once and answers the rest at once without counting them", async () => {
    const slow = deferred<string>();
    store.saltFor.mockImplementation(() => slow.promise);
    const responses = Array.from({ length: 5 }, (_, i) => POST(beacon({ path: `/burst-${i}` })));
    await vi.waitFor(() => expect(store.saltFor).toHaveBeenCalledTimes(3));
    slow.resolve("ab".repeat(32));
    for (const response of await Promise.all(responses)) {
      await expectEmpty204(response);
    }
    expect(store.saltFor).toHaveBeenCalledTimes(3);
    expect(store.rows).toHaveLength(3);

    // The slots are free again once the work ends.
    store.saltFor.mockImplementation(async () => "ab".repeat(32));
    await expectEmpty204(await POST(beacon({ path: "/after" })));
    expect(store.rows).toHaveLength(4);
  });
});
