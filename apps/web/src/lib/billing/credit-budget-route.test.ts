import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { CREDIT_BUDGET_OWNER_MESSAGE } from "./credit-budget";

const state = vi.hoisted(() => ({ role: "owner", signedIn: true, db: true, user: true }));
const budget = vi.hoisted(() => ({ monthlyLimit: null, remaining: null, consumed: 0, held: 0, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" }));
const save = vi.hoisted(() => vi.fn(async () => {}));
const read = vi.hoisted(() => vi.fn(async () => ({ budget })));
vi.mock("@/lib/http/services", () => ({ resolveSignedIn: async () => state.signedIn
  ? { workspace: { id: "ws-trusted", role: state.role, creditBalance: 100 }, services: {} }
  : { response: NextResponse.json({ error: "Sign in" }, { status: 401 }) } }));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.db }));
vi.mock("@/lib/services/db", () => ({ getDb: () => "trusted-db" }));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => state.user ? { id: "owner-trusted" } : null }));
vi.mock("./credit-planning", () => ({ readCreditBudget: async () => budget, readCreditPlanning: read, setCreditBudget: save,
  demoCreditPlanning: () => ({ budget }) }));
const { GET, POST } = await import("@/app/api/billing/budget/route");
const { GET: planning } = await import("@/app/api/billing/planning/route");
function request(body: unknown, origin = "https://curvi.ai") {
  return new Request("https://curvi.ai/api/billing/budget", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
}
beforeEach(() => { Object.assign(state, { role: "owner", signedIn: true, db: true, user: true }); save.mockClear(); read.mockClear(); vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai"); });
afterEach(() => vi.unstubAllEnvs());

describe("owner budget boundary", () => {
  it("uses authenticated identity and workspace, accepting zero and disable explicitly", async () => {
    expect((await POST(request({ monthlyLimit: 0 }))).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith("trusted-db", "ws-trusted", "owner-trusted", 0);
    expect((await POST(request({ monthlyLimit: null }))).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith("trusted-db", "ws-trusted", "owner-trusted", null);
  });
  it.each(["admin", "editor", "client"])("refuses %s writes before reaching the trusted setter", async (role) => {
    state.role = role;
    const result = await POST(request({ monthlyLimit: 50 }));
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: CREDIT_BUDGET_OWNER_MESSAGE });
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses signout, spoofed identity, fractional excess, cross-site and demo writes", async () => {
    expect((await POST(request({ monthlyLimit: 10, actorId: "someone" }))).status).toBe(400);
    expect((await POST(request({ monthlyLimit: 0.12 }))).status).toBe(400);
    expect((await POST(request({ monthlyLimit: 10 }, "https://other.test"))).status).toBe(403);
    state.signedIn = false;
    expect((await POST(request({ monthlyLimit: 10 }))).status).toBe(401);
    state.signedIn = true; state.user = false;
    expect((await POST(request({ monthlyLimit: 10 }))).status).toBe(401);
    state.user = true; state.db = false;
    expect((await POST(request({ monthlyLimit: 10 }))).status).toBe(503);
    expect(save).not.toHaveBeenCalled();
  });
  it("restricts full planning to billing managers and only provides generating members estimate headroom", async () => {
    state.role = "editor";
    expect((await planning()).status).toBe(403);
    const estimate = await GET();
    expect(estimate.status).toBe(200);
    expect(estimate.headers.get("cache-control")).toBe("private, no-store");
    state.role = "client";
    expect((await GET()).status).toBe(403);
    state.role = "admin";
    expect((await planning()).status).toBe(200);
  });
});
