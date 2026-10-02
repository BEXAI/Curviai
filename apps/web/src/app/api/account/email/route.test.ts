import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: { id: "user", email: "old@example.com", email_confirmed_at: "now" } as null | { id: string; email: string; email_confirmed_at: string }, update: vi.fn(), remember: vi.fn() }));
vi.mock("@/lib/auth/email-change", () => ({ rememberEmailChange: state.remember }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }), updateUser: state.update } }) }));
vi.mock("@/lib/rate-limit", () => ({ limitByIp: async () => null, limitByUser: async () => null }));
import { POST } from "./route";
function request(origin = "https://curvi.ai") { return new Request("https://curvi.ai/api/account/email", { method: "POST", headers: { host: "curvi.ai", origin, "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com" }) }); }
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai"); vi.clearAllMocks(); state.user = { id: "user", email: "old@example.com", email_confirmed_at: "now" }; state.update.mockResolvedValue({ error: null }); });
describe("email change action", () => {
  it("records the verified old identity and sends the new address through confirmation", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(state.remember).toHaveBeenCalledWith({}, "user", "old@example.com", "new@example.com");
    expect(state.update).toHaveBeenCalledWith({ email: "new@example.com" }, { emailRedirectTo: "https://curvi.ai/auth/confirm?next=%2Fapp%2Fsettings" });
  });
  it("refuses signed out and cross-origin requests before changing Auth", async () => {
    state.user = null; expect((await POST(request())).status).toBe(401); expect((await POST(request("https://evil.test"))).status).toBe(403); expect(state.update).not.toHaveBeenCalled();
  });
  it("returns fixed copy for provider failures", async () => {
    state.update.mockResolvedValue({ error: { code: "email_exists", message: "private upstream detail" } });
    const response = await POST(request()); expect(response.status).toBe(400); expect(await response.text()).not.toContain("private upstream");
  });
});

afterEach(() => vi.unstubAllEnvs());
