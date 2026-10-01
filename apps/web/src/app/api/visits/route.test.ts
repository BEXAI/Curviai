import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageViewRow, VisitStore } from "@/lib/visits/store";

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");
const { setVisitStoreForTests } = await import("@/lib/visits/store");

const URL = "http://localhost:3000/api/visits";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

class FakeStore implements VisitStore {
  rows: PageViewRow[] = [];
  fail = false;
  saltFor = vi.fn(async () => "ab".repeat(32));
  async record(view: PageViewRow): Promise<boolean> {
    if (this.fail) {
      throw new Error("database is down");
    }
    this.rows.push(view);
    return true;
  }
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
});

afterEach(() => {
  setVisitStoreForTests(undefined);
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
    try {
      store.saltFor.mockImplementation(() => new Promise<string>(() => undefined));
      const pending = POST(beacon({ path: "/" }));
      await vi.advanceTimersByTimeAsync(3000);
      await expectEmpty204(await pending);
    } finally {
      vi.useRealTimers();
    }
  });
});
