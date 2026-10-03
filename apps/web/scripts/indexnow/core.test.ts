import { describe, expect, it, vi } from "vitest";
import { initializeState, refreshState, retryEntry, recordIndexing, retryAfterMs, submitChanges, dueEntries, verifyOwnership } from "./core";
import { INDEXNOW_ENDPOINT, indexNowKeyLocation, type IndexNowState } from "./model";
import type { Inventory, Observation } from "./inventory";

const KEY = "dummy-approved-test-proof-1234";
const T0 = new Date("2026-10-03T00:00:00.000Z");
const T1 = new Date("2026-10-03T01:00:00.000Z");
const PAGE = "https://curvi.ai/pricing";
const item = (url = PAGE, hash = "a", kind: "page" | "deleted" = "page"): Observation => ({ url, kind, fingerprint: hash.repeat(64) });
const inventory = (...observations: Observation[]): Inventory => ({ observations, excluded: [] });
const baseline = () => initializeState(inventory(item()), T0);
const pending = () => refreshState(baseline(), inventory(item(PAGE, "b")), T1);

function network(statuses: Array<number | Error>, headers: Record<string, string> = {}) {
  const posts: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === indexNowKeyLocation(KEY)) return new Response(KEY, { headers: { "content-type": "text/plain" } });
    posts.push({ url, init: init! });
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("Unexpected extra POST");
    return new Response("Do not store this response body", { status: next, headers });
  }) as unknown as typeof fetch;
  return { fetcher, posts };
}

describe("change-only notification inventory", () => {
  it("establishes a baseline without queueing historical pages", () => {
    const state = baseline();
    expect(state.entries[0]?.outcome).toBe("baseline");
    expect(dueEntries(state, T1)).toEqual([]);
    expect(state.entries[0]?.indexing).toBe("unknown");
  });

  it("does not queue unchanged content or a sitemap-only date change", () => {
    const state = refreshState(baseline(), inventory({ ...item(), lastmod: "2026-10-02" }), T1);
    expect(dueEntries(state, T1)).toEqual([]);
  });

  it("queues real content changes, new pages and confirmed deletions", () => {
    const state = refreshState(baseline(), inventory(item(PAGE, "b", "deleted"), item("https://curvi.ai/new-guide")), T1);
    expect(dueEntries(state, T1).map((entry) => entry.kind)).toEqual(["page", "deleted"]);
    expect(state.entries.every((entry) => entry.outcome === "queued")).toBe(true);
  });

  it("never infers a deletion from missing or ineligible content", () => {
    expect(() => refreshState(baseline(), inventory(), T1)).toThrow("did not account");
    const excluded = refreshState(baseline(), { observations: [], excluded: [{ url: PAGE, reason: "meta-noindex" }] }, T1);
    expect(excluded.entries[0]?.outcome).toBe("excluded");
    expect(dueEntries(excluded, T1)).toEqual([]);
    expect(() => refreshState(baseline(), inventory(item(), item("https://curvi.ai/deleted", "b", "deleted")), T1)).toThrow("existing baseline");
  });

  it("rejects private, foreign, duplicate and empty initial inventories", () => {
    for (const url of ["https://curvi.ai/app", "https://curvi.ai/api/health", "https://example.com/", "https://curvi.ai/?token=secret"]) {
      expect(() => initializeState(inventory(item(url)), T0)).toThrow("ineligible");
    }
    expect(() => initializeState(inventory(item(), item()), T0)).toThrow("duplicate");
    expect(() => initializeState(inventory(), T0)).toThrow("empty");
  });
});

describe("bounded single-endpoint delivery", () => {
  it.each([[200, "accepted"], [202, "key_pending"]] as const)("persists %s as %s without claiming indexed", async (status, outcome) => {
    const net = network([status]);
    const saved: IndexNowState[] = [];
    const state = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async (s) => { saved.push(structuredClone(s)); } });
    expect(saved.map((s) => s.entries[0]?.outcome)).toEqual(["attempting", outcome]);
    expect(saved[0]?.budget.urlAttempts).toBe(1);
    expect(state.entries[0]?.indexing).toBe("unknown");
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(JSON.stringify(state)).not.toContain("Do not store");
    expect(net.posts).toHaveLength(1);
    expect(net.posts[0]?.url).toBe(INDEXNOW_ENDPOINT);
    expect(net.posts[0]?.init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(JSON.parse(String(net.posts[0]?.init.body))).toEqual({ host: "curvi.ai", key: KEY, urlList: [PAGE] });
    const refreshed = refreshState(state, inventory(item(PAGE, "b")), new Date("2026-10-03T03:00:00Z"));
    await submitChanges({ state: refreshed, key: KEY, fetcher: net.fetcher, now: () => new Date("2026-10-03T03:00:00Z"), save: async () => undefined });
    expect(net.posts).toHaveLength(1);
  });

  it("never sends before write-ahead persistence succeeds", async () => {
    const net = network([200]);
    await expect(submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    expect(net.posts).toHaveLength(0);
  });

  it("leaves an ambiguous durable attempt if saving its response fails", async () => {
    const net = network([200]);
    let durable = pending();
    const save = vi.fn(async (state: IndexNowState) => { if (save.mock.calls.length === 2) throw new Error("disk full"); durable = structuredClone(state); });
    await expect(submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save })).rejects.toThrow("disk full");
    expect(net.posts).toHaveLength(1);
    expect(durable.entries[0]?.outcome).toBe("attempting");
    const recovered = refreshState(durable, inventory(item(PAGE, "b")), T1);
    expect(recovered.entries[0]?.outcome).toBe("unknown");
    expect(dueEntries(recovered, T1)).toEqual([]);
  });

  it.each([400, 403, 422, 301])("holds HTTP %s failures without automatic retries", async (status) => {
    const net = network([status]);
    const state = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    expect(state.entries[0]).toMatchObject({ outcome: "failed", httpStatus: status, indexing: "unknown" });
    expect(dueEntries(state, new Date("2026-10-04T00:00:00Z"))).toEqual([]);
  });

  it("holds a network timeout as unknown until an explicit duplicate-risk acknowledgement", async () => {
    const net = network([new Error("may have arrived")]);
    const state = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    expect(state.entries[0]?.outcome).toBe("unknown");
    expect(() => retryEntry(state, PAGE, false)).toThrow("duplicate risk");
    const retry = retryEntry(state, PAGE, true);
    expect(retry.entries[0]?.outcome).toBe("queued");
    expect(dueEntries(retry, T1)).toEqual([]);
    expect(dueEntries(retry, new Date("2026-10-03T01:05:00Z"))).toHaveLength(1);
  });

  it("splits batches at 100 and obeys per-run and persistent daily attempt budgets", async () => {
    const pages = Array.from({ length: 251 }, (_, i) => item(`https://curvi.ai/page-${i}`));
    const state = refreshState(baseline(), inventory(item(), ...pages), T1);
    state.budget.urlAttempts = 350;
    const net = network([200, 200]);
    const result = await submitChanges({ state, key: KEY, maxUrls: 250, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    expect(net.posts.map((post) => JSON.parse(String(post.init.body)).urlList.length)).toEqual([100, 50]);
    expect(result.budget.urlAttempts).toBe(500);
    expect(result.entries.filter((entry) => entry.outcome === "queued")).toHaveLength(101);
  });

  it("blocks rapid changed-content repeats for five minutes", async () => {
    const net = network([200]);
    const first = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    const changed = refreshState(first, inventory(item(PAGE, "c")), new Date("2026-10-03T01:01:00Z"));
    expect(dueEntries(changed, new Date("2026-10-03T01:04:59Z"))).toHaveLength(0);
    expect(dueEntries(changed, new Date("2026-10-03T01:05:00Z"))).toHaveLength(1);
  });
});

describe("retry scheduling", () => {
  it.each([429, 500, 503])("persists HTTP %s Retry-After and stops other batches", async (status) => {
    const net = network([status], { "Retry-After": "1200" });
    const state = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    expect(state.blockedUntil).toBe("2026-10-03T01:20:00.000Z");
    expect(state.entries[0]?.outcome).toBe("retryable");
    expect(dueEntries(state, new Date("2026-10-03T01:19:59Z"))).toEqual([]);
    expect(net.posts).toHaveLength(1);
  });

  it("honors HTTP-date Retry-After and holds extreme delays", () => {
    expect(retryAfterMs("Sat, 03 Oct 2026 01:30:00 GMT", T1)).toBe(30 * 60_000);
    expect(retryAfterMs("invalid", T1)).toBeNull();
    expect(retryAfterMs("99999999999999999999", T1)).toBe(Infinity);
  });

  it("backs off across runs and stops after three classified attempts", async () => {
    let clock = T1;
    let state = pending();
    const net = network([503, 503, 503]);
    for (const minutes of [0, 5, 15]) {
      clock = new Date(T1.getTime() + minutes * 60_000);
      state = await submitChanges({ state, key: KEY, fetcher: net.fetcher, now: () => clock, save: async () => undefined });
    }
    expect(net.posts).toHaveLength(3);
    expect(state.entries[0]).toMatchObject({ outcome: "failed", reason: "attempt_limit", attemptCount: 3 });
    expect(dueEntries(state, new Date("2026-10-04T01:00:00Z"))).toEqual([]);
  });
});

describe("ownership and indexing evidence", () => {
  it.each([new Response("wrong", { headers: { "content-type": "text/plain" } }), new Response(KEY, { status: 404 }), new Response(KEY, { headers: { "content-type": "text/html" } })])("refuses an invalid ownership response", async (response) => {
    await expect(verifyOwnership(KEY, vi.fn(async () => response) as unknown as typeof fetch)).rejects.toThrow("Ownership");
  });

  it("records indexing only from an explicit current operator observation, separately from receipt", () => {
    const state = recordIndexing(baseline(), PAGE, "indexed", T1, T1);
    expect(state.entries[0]).toMatchObject({ outcome: "baseline", indexing: "indexed", indexingSource: "operator_recorded_bing_inspection" });
    expect(() => recordIndexing(state, PAGE, "indexed", new Date("2027-01-01"), T1)).toThrow("future");
    const changed = refreshState(state, inventory(item(PAGE, "b")), T1);
    expect(changed.entries[0]?.indexing).toBe("unknown");
    expect(changed.entries[0]?.indexingObservedAt).toBeUndefined();
    const excluded = refreshState(state, { observations: [], excluded: [{ url: PAGE, reason: "meta-noindex" }] }, T1);
    expect(excluded.entries[0]?.indexing).toBe("unknown");
    expect(excluded.entries[0]?.indexingObservedAt).toBeUndefined();
  });

  it("records genuine Bing indexing lag after a public page is deleted or excluded", () => {
    const removed = refreshState(baseline(), inventory(item(PAGE, "b", "deleted")), T1);
    const stillIndexed = recordIndexing(removed, PAGE, "indexed", T1, T1);
    expect(stillIndexed.entries[0]).toMatchObject({ kind: "deleted", outcome: "queued", indexing: "indexed", indexingSource: "operator_recorded_bing_inspection" });
    const hidden = refreshState(baseline(), { observations: [], excluded: [{ url: PAGE, reason: "meta-noindex" }] }, T1);
    const observed = recordIndexing(hidden, PAGE, "indexed", T1, T1);
    const same = refreshState(observed, { observations: [], excluded: [{ url: PAGE, reason: "meta-noindex" }] }, T1);
    expect(same.entries[0]).toMatchObject({ outcome: "excluded", indexing: "indexed" });
  });

  it("allows a reviewed key-pending retry only with explicit duplicate-risk acknowledgement", async () => {
    const net = network([202]);
    const state = await submitChanges({ state: pending(), key: KEY, fetcher: net.fetcher, now: () => T1, save: async () => undefined });
    expect(() => retryEntry(state, PAGE, false)).toThrow("duplicate risk");
    const retry = retryEntry(state, PAGE, true);
    expect(retry.entries[0]?.outcome).toBe("queued");
    expect(dueEntries(retry, T1)).toEqual([]);
  });
});
