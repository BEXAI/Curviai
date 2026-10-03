import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoCaseState, DemoCaseStore } from "@/lib/cases/demo-store";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { createFakeServices, jsonRequest, TEST_JOB_ID, TEST_PRODUCT_ID } from "@/lib/testing/fake-services";
import type { JobView, Services } from "@/lib/services/types";
let services: Services, store: DemoCaseStore;
vi.mock("@/lib/services", () => ({ getServices: () => services, isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => null, createSupabaseServerClient: async () => null }));
vi.mock("@/lib/cases", async (original) => ({ ...await original<typeof import("@/lib/cases")>(), getCaseStore: () => store }));
const { GET, POST } = await import("./route");
const { POST: reply } = await import("./[caseId]/route");
const url = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/cases`;
const params = (id = TEST_JOB_ID) => ({ params: Promise.resolve({ id }) });
const input = () => ({ category: "fidelity", description: "This label looks blurred.", requestId: randomUUID() });
beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.getJob).mockImplementation(async (_ws, id) => id === TEST_JOB_ID ? { id, productId: TEST_PRODUCT_ID, productTitle: "Mug", status: "done", mode: "listing", channels: ["amazon"], creditsReserved: 0, creditsCharged: 3, createdAt: "2026-10-01T00:00:00Z", shots: [] } satisfies JobView : null);
  store = new DemoCaseStore(services, new DemoCaseState()); setRateLimitStoreForTests(new MemoryRateLimitStore());
});
afterEach(() => { setRateLimitStoreForTests(null); });
describe("case HTTP boundaries", () => {
  it("creates once, reloads the same public timeline, and records a reply once", async () => {
    const body = input();
    const response = await POST(jsonRequest(url, body), params());
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    const saved = await response.json();
    expect((await POST(jsonRequest(url, body), params())).status).toBe(200);
    const reloaded = await (await GET(new Request(url), params())).json();
    expect(reloaded.cases).toHaveLength(1); expect(reloaded.cases[0].id).toBe(saved.case.id);
    const replyInput = { requestId: randomUUID(), message: "The original photo is much clearer.", reopen: false };
    const context = { params: Promise.resolve({ id: TEST_JOB_ID, caseId: saved.case.id }) };
    expect((await reply(jsonRequest(`${url}/${saved.case.id}`, replyInput), context)).status).toBe(200);
    expect((await (await reply(jsonRequest(`${url}/${saved.case.id}`, replyInput), context)).json()).case.events).toHaveLength(2);
  });
  it("refuses cross-origin, malformed, signed-out and missing-pack writes", async () => {
    expect((await POST(new Request(url, { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify(input()) }), params())).status).toBe(403);
    expect((await POST(jsonRequest(url, { ...input(), description: "x".repeat(2001) }), params())).status).toBe(400);
    expect((await POST(jsonRequest(url, { ...input(), private: true }), params())).status).toBe(400);
    expect((await POST(jsonRequest(url, input()), params("not-an-id"))).status).toBe(404);
    expect((await POST(jsonRequest(url, input()), params(randomUUID()))).status).toBe(404);
    services = createFakeServices(null);
    expect((await GET(new Request(url), params())).status).toBe(401);
  });
  it("shares the support intake rate limit across distinct report attempts", async () => {
    const responses = [];
    for (let index = 0; index < 12; index += 1) responses.push((await POST(jsonRequest(url, input()), params())).status);
    expect(responses).toContain(429);
  });
});
