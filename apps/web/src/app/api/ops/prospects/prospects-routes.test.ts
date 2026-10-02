import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { Services } from "@/lib/services/types";
import { createFakeServices, jsonRequest, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

// P18-04: every operator route answers 404 to anyone who is not an
// operator (OPS_EMAILS, founder decision 15), 503 without the database, and
// maps the service's answers to statuses for an operator.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string; email_confirmed_at?: string | null },
  dbMode: true,
  aal: "aal2",
}));
let services: Services;

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => state.user,
  createSupabaseServerClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: state.user } }),
    getClaims: async () => ({ data: { claims: { sub: state.user?.id, aal: state.aal } } }),
  } }),
}));
vi.mock("@/lib/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services")>()),
  getServices: () => services,
  isDbMode: () => state.dbMode,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

const service = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  link: vi.fn(),
  kit: vi.fn(),
}));
vi.mock("@/lib/prospects/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospects/service")>()),
  createProspectPack: service.create,
  prospectsWithPublishing: service.list,
  makeClaimLink: service.link,
  claimKit: service.kit,
}));
const credits = vi.hoisted(() => ({ add: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/prospects/credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prospects/credits")>()),
  addProspectCredits: credits.add,
  prospectCreditStatus: credits.status,
}));
vi.mock("@/lib/shares", () => ({ getShareStore: () => ({}) }));

const prospects = await import("./route");
const creditRoute = await import("./credits/route");
const linkRoute = await import("./[id]/link/route");

const OPERATOR = { id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090", email: "Founder@Curvi.ai", email_confirmed_at: "2026-09-30T00:00:00Z" };
const CLAIM_ID = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";
const BASE = "https://curvi.ai/api/ops/prospects";
const VALID = {
  store: "Juniper Candles",
  channels: ["amazon"],
  upload: { key: `ws/${TEST_WORKSPACE_ID}/src/a.jpg`, sha256: "a".repeat(64), kind: "image" },
  idempotencyKey: "abcdef123456",
};

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", "founder@curvi.ai");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  state.user = OPERATOR;
  state.dbMode = true;
  state.aal = "aal2";
  services = createFakeServices("owner");
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  service.list.mockResolvedValue([]);
  credits.status.mockResolvedValue({ usedThisMonth: 0, cap: 400 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setRateLimitStoreForTests(null);
  vi.clearAllMocks();
});

async function everyRoute(): Promise<number[]> {
  return [
    (await prospects.GET()).status,
    (await prospects.POST(jsonRequest(BASE, VALID))).status,
    (await creditRoute.POST(jsonRequest(`${BASE}/credits`, { credits: 10 }))).status,
    (await linkRoute.POST(jsonRequest(`${BASE}/${CLAIM_ID}/link`, {}), { params: Promise.resolve({ id: CLAIM_ID }) })).status,
    (await linkRoute.GET(new Request(`${BASE}/${CLAIM_ID}/link`), { params: Promise.resolve({ id: CLAIM_ID }) })).status,
  ];
}

describe("the operator gate", () => {
  it("refuses an operator without a verified second-factor session before any operation", async () => {
    state.aal = "aal1";
    expect(await everyRoute()).toEqual([403, 403, 403, 403, 403]);
    expect(service.create).not.toHaveBeenCalled();
    expect(credits.add).not.toHaveBeenCalled();
  });
  it("answers 404 signed out, to a signed in seller, and to an unconfirmed operator email", async () => {
    for (const user of [null, { id: OPERATOR.id, email: "seller@shop.example", email_confirmed_at: "2026-09-30T00:00:00Z" }, { ...OPERATOR, email_confirmed_at: null }]) {
      state.user = user;
      expect(await everyRoute()).toEqual([404, 404, 404, 404, 404]);
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(credits.add).not.toHaveBeenCalled();
    expect(service.link).not.toHaveBeenCalled();
    expect(service.kit).not.toHaveBeenCalled();
  });

  it("answers 404 to everyone when OPS_EMAILS is empty", async () => {
    vi.stubEnv("OPS_EMAILS", "");
    expect(await everyRoute()).toEqual([404, 404, 404, 404, 404]);
  });

  it("answers 503 to an operator without the database", async () => {
    state.dbMode = false;
    expect(await everyRoute()).toEqual([503, 503, 503, 503, 503]);
  });
});

describe("for an operator", () => {
  it("lists prospects with this month's credits and the balance", async () => {
    const response = await prospects.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prospects: [], credits: { usedThisMonth: 0, cap: 400, balance: 100 } });
  });

  it("makes a pack, refusing a bad body before the service", async () => {
    expect((await prospects.POST(jsonRequest(BASE, { ...VALID, channels: ["myspace"] }))).status).toBe(400);
    expect((await prospects.POST(jsonRequest(BASE, { store: "x" }))).status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
    service.create.mockResolvedValueOnce({ ok: true, created: true, prospect: null, jobId: "j" });
    expect((await prospects.POST(jsonRequest(BASE, VALID))).status).toBe(201);
    service.create.mockResolvedValueOnce({ ok: false, status: 402, error: "Not enough credits.", reason: "insufficient_credits" });
    const short = await prospects.POST(jsonRequest(BASE, VALID));
    expect(short.status).toBe(402);
    expect((await short.json()).reason).toBe("insufficient_credits");
    const crossSite = await prospects.POST(jsonRequest(BASE, VALID, { origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
  });

  it("adds credits under the cap and says how many are left over it", async () => {
    credits.add.mockResolvedValueOnce({ outcome: "added", credits: 40, status: { usedThisMonth: 40, cap: 400 } });
    const added = await creditRoute.POST(jsonRequest(`${BASE}/credits`, { credits: 40 }));
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ added: 40, credits: { usedThisMonth: 40, cap: 400, balance: 140 } });
    credits.add.mockResolvedValueOnce({ outcome: "over_cap", left: 10, status: { usedThisMonth: 390, cap: 400 } });
    const over = await creditRoute.POST(jsonRequest(`${BASE}/credits`, { credits: 40 }));
    expect(over.status).toBe(409);
    expect((await over.json()).error).toContain("up to 10 more");
    expect((await creditRoute.POST(jsonRequest(`${BASE}/credits`, { credits: "lots" }))).status).toBe(400);
  });

  it("makes a claim link, 404 for a bad id", async () => {
    service.link.mockResolvedValueOnce({ ok: true, link: "https://curvi.ai/s/abc?claim=x", expiresAt: "2026-11-01T00:00:00Z", kit: {} });
    const made = await linkRoute.POST(jsonRequest(`${BASE}/${CLAIM_ID}/link`, {}), { params: Promise.resolve({ id: CLAIM_ID }) });
    expect(made.status).toBe(200);
    expect((await made.json()).link).toBe("https://curvi.ai/s/abc?claim=x");
    expect(service.link.mock.calls[0][2]).toMatchObject({ claimId: CLAIM_ID, origin: "https://curvi.ai" });
    const bad = await linkRoute.POST(jsonRequest(`${BASE}/nope/link`, {}), { params: Promise.resolve({ id: "nope" }) });
    expect(bad.status).toBe(404);
  });

  it("shows the kit again without making a new link (GET)", async () => {
    service.kit.mockResolvedValueOnce({ ok: true, link: "https://curvi.ai/s/abc?claim=x", expiresAt: "2026-11-01T00:00:00Z", kit: {} });
    const shown = await linkRoute.GET(new Request(`${BASE}/${CLAIM_ID}/link`), { params: Promise.resolve({ id: CLAIM_ID }) });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.json()).toEqual({ link: "https://curvi.ai/s/abc?claim=x", expiresAt: "2026-11-01T00:00:00Z", kit: {} });
    expect(service.kit.mock.calls[0][1]).toMatchObject({ claimId: CLAIM_ID, origin: "https://curvi.ai" });
    expect(service.link).not.toHaveBeenCalled();
    service.kit.mockResolvedValueOnce({ ok: false, status: 409, error: "The pack is not ready to send yet.", reason: "not_ready" });
    const early = await linkRoute.GET(new Request(`${BASE}/${CLAIM_ID}/link`), { params: Promise.resolve({ id: CLAIM_ID }) });
    expect(early.status).toBe(409);
  });
});
