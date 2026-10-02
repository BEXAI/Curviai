import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: null as null | { id: string; email: string; email_confirmed_at?: string }, mode: "fallback" as "fallback" | "configured" | "misconfigured", verified: false, send: vi.fn(), job: vi.fn(async () => null as unknown), insert: vi.fn(async () => {}), ipLimit: vi.fn(async () => null as Response | null), userLimit: vi.fn(async () => null as Response | null) }));
vi.mock("@curvi/email", async (original) => ({ ...await original<typeof import("@curvi/email")>(), sendEmail: state.send, emailConfigFromEnv: () => ({ from: "support@example.com", apiKey: "fake", siteUrl: "https://curvi.ai" }) }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true, getServices: () => ({ getCurrentWorkspace: async () => ({ id: "workspace" }), getJob: state.job }) }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ insert: () => ({ values: state.insert }) }) }));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/rate-limit", () => ({ limitByIp: state.ipLimit, limitByUser: state.userLimit, clientIp: () => "192.0.2.1" }));
vi.mock("@/lib/turnstile", () => ({ turnstileMode: () => state.mode, verifyTurnstile: async () => state.verified, TURNSTILE_MESSAGE: "Human check failed." }));
import { POST } from "./route";
const job = "10000000-0000-4000-8000-000000000001";
function request() { return new Request("https://curvi.ai/api/support", { method: "POST", headers: { host: "curvi.ai", origin: "https://curvi.ai", "content-type": "application/json" }, body: JSON.stringify({ topic: "pack", message: "This is a private comment", email: "submitted@example.com", job, requestId: "20000000-0000-4000-8000-000000000001" }) }); }
beforeEach(() => { vi.clearAllMocks(); state.mode = "fallback"; state.verified = false; state.user = null; state.send.mockResolvedValue({ status: "sent" }); state.ipLimit.mockResolvedValue(null); state.userLimit.mockResolvedValue(null); });
describe("support route", () => {
  it("enforces the IP budget before any email is sent", async () => { state.ipLimit.mockResolvedValue(new Response(null, { status: 429 })); expect((await POST(request())).status).toBe(429); expect(state.send).not.toHaveBeenCalled(); });
  it("sends only the inbox message for an unchecked visitor", async () => {
    expect((await POST(request())).status).toBe(200); expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({ config: { replyTo: "submitted@example.com" } });
    expect(state.send.mock.calls[0]?.[1]).toMatchObject({ data: { job: null }, template: { kind: "transactional" } });
  });
  it("uses a confirmed account and attaches only its owned pack", async () => {
    state.user = { id: "user", email: "verified@example.com", email_confirmed_at: "now" }; state.job.mockResolvedValue({ id: job });
    expect((await POST(request())).status).toBe(200); expect(state.userLimit).toHaveBeenCalledWith("support.contact", "user"); expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[0]?.[0]).toMatchObject({ config: { replyTo: "verified@example.com" } });
    expect(state.send.mock.calls[0]?.[1]).toMatchObject({ data: { job } });
    const reply = state.send.mock.calls[1]?.[1]; expect(reply).toMatchObject({ to: "verified@example.com", data: {}, template: { kind: "transactional" } });
    expect(JSON.stringify(reply.template.render({}, {}))).not.toContain("private comment"); expect(JSON.stringify(state.insert.mock.calls)).not.toContain("private comment");
  });
  it("treats an unconfirmed account as unsigned for CAPTCHA", async () => {
    state.user = { id: "user", email: "unconfirmed@example.com" }; state.mode = "configured";
    expect((await POST(request())).status).toBe(400); expect(state.send).not.toHaveBeenCalled();
  });
});
