import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseRefusal } from "@/lib/cases/types";
const state = vi.hoisted(() => ({ user: null as null | { id: string; email: string; email_confirmed_at?: string }, mode: "fallback" as "fallback" | "configured" | "misconfigured", verified: false, createCase: vi.fn(), send: vi.fn(), job: vi.fn(async () => null as unknown), insert: vi.fn(async () => {}), ipLimit: vi.fn(async () => null as Response | null), userLimit: vi.fn(async () => null as Response | null) }));
vi.mock("@/lib/cases", () => ({ getCaseStore: () => ({ create: state.createCase }) }));
vi.mock("@curvi/email", async (original) => ({ ...await original<typeof import("@curvi/email")>(), sendEmail: state.send, emailConfigFromEnv: () => ({ from: "support@example.com", apiKey: "fake", siteUrl: "https://curvi.ai" }) }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true, getServices: () => ({ getCurrentWorkspace: async () => ({ id: "workspace" }), getJob: state.job }) }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ insert: () => ({ values: state.insert }) }) }));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/rate-limit", () => ({ limitByIp: state.ipLimit, limitByUser: state.userLimit, clientIp: () => "192.0.2.1" }));
vi.mock("@/lib/turnstile", () => ({ turnstileMode: () => state.mode, verifyTurnstile: async () => state.verified, TURNSTILE_MESSAGE: "Human check failed." }));
import { POST } from "./route";
const job = "10000000-0000-4000-8000-000000000001";
function request(topic = "pack") { return new Request("https://curvi.ai/api/support", { method: "POST", headers: { host: "curvi.ai", origin: "https://curvi.ai", "content-type": "application/json" }, body: JSON.stringify({ topic, message: "This is a private comment", email: "submitted@example.com", job, requestId: "20000000-0000-4000-8000-000000000001" }) }); }
beforeEach(() => { vi.clearAllMocks(); state.mode = "fallback"; state.verified = false; state.user = null; state.send.mockResolvedValue({ status: "sent" }); state.createCase.mockResolvedValue({ created: true, case: { id: "30000000-0000-4000-8000-000000000001" } }); state.ipLimit.mockResolvedValue(null); state.userLimit.mockResolvedValue(null); });
describe("support route", () => {
  it("enforces the IP budget before any email is sent", async () => { state.ipLimit.mockResolvedValue(new Response(null, { status: 429 })); expect((await POST(request())).status).toBe(429); expect(state.send).not.toHaveBeenCalled(); });
  it("sends only the inbox message for an unchecked visitor", async () => {
    expect((await POST(request())).status).toBe(200); expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({ config: { replyTo: "submitted@example.com" } });
    expect(state.send.mock.calls[0]?.[1]).toMatchObject({ data: { job: null }, template: { kind: "transactional" } });
  });
  it("turns a confirmed account's pack support submission into one case without duplicate intake mail", async () => {
    state.user = { id: "user", email: "verified@example.com", email_confirmed_at: "now" }; state.job.mockResolvedValue({ id: job });
    const response = await POST(request());
    expect(response.status).toBe(200); expect(state.userLimit).toHaveBeenCalledWith("support.contact", "user"); expect(state.send).not.toHaveBeenCalled();
    expect(state.createCase).toHaveBeenCalledWith({ workspaceId: "workspace", userId: "user" }, job, { category: "other", description: "This is a private comment", requestId: "20000000-0000-4000-8000-000000000001" }, "20000000-0000-4000-8000-000000000001");
    expect(await response.json()).toMatchObject({ casePath: `/app/jobs/${job}/cases#case-30000000-0000-4000-8000-000000000001` });
    expect(state.insert).not.toHaveBeenCalled();
    state.createCase.mockResolvedValue({ created: false, case: { id: "30000000-0000-4000-8000-000000000001" } });
    expect((await POST(request())).status).toBe(200); expect(state.send).not.toHaveBeenCalled();
  });
  it("treats an unconfirmed account as unsigned for CAPTCHA", async () => {
    state.user = { id: "user", email: "unconfirmed@example.com" }; state.mode = "configured";
    expect((await POST(request())).status).toBe(400); expect(state.send).not.toHaveBeenCalled();
  });
  it("keeps ordinary confirmed-account support on its existing inbox and acknowledgment path", async () => {
    state.user = { id: "user", email: "verified@example.com", email_confirmed_at: "now" };
    expect((await POST(request("billing"))).status).toBe(200);
    expect(state.createCase).not.toHaveBeenCalled(); expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({ config: { replyTo: "verified@example.com" } });
    expect(state.send.mock.calls[1]?.[1]).toMatchObject({ to: "verified@example.com", data: {} });
  });
  it("does not email when a case refers to another tenant's pack", async () => {
    state.user = { id: "user", email: "verified@example.com", email_confirmed_at: "now" };
    state.createCase.mockRejectedValue(new CaseRefusal("not_found", "This pack is not available."));
    expect((await POST(request())).status).toBe(404); expect(state.send).not.toHaveBeenCalled();
  });
});
