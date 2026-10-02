import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ verify: vi.fn(), finish: vi.fn(async () => "/oauth/consent?authorization_id=abc"), email: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { verifyOtp: state.verify } }) }));
vi.mock("@/lib/auth/finish", () => ({ finishSignIn: state.finish }));
vi.mock("@/lib/auth/email-change", () => ({ finishEmailChange: state.email }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/http/public-origin", () => ({ publicOrigin: () => "https://curvi.ai" }));
import { GET, POST } from "./route";
function request(type = "email", origin = "https://curvi.ai") { return new NextRequest("https://curvi.ai/auth/confirm", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ type, token_hash: "a".repeat(32), next: "https://curvi.ai/auth/callback?next=%2Foauth%2Fconsent%3Fauthorization_id%3Dabc&attr=source" }) }); }
beforeEach(() => { vi.clearAllMocks(); state.verify.mockResolvedValue({ data: { user: { id: "user" } }, error: null }); });
describe("confirm email", () => {
  it("does not consume a token on scanner GET and escapes hidden fields", async () => {
    const response = await GET(new NextRequest("https://curvi.ai/auth/confirm?token_hash=%22%3E%3Cscript%3E"));
    expect(await response.text()).not.toContain('<script>'); expect(state.verify).not.toHaveBeenCalled();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("passes signup through the same finish steps and resumes consent", async () => {
    const response = await POST(request());
    expect(response.headers.get("location")).toBe("https://curvi.ai/oauth/consent?authorization_id=abc");
    expect(state.finish).toHaveBeenCalledWith(expect.objectContaining({ next: "/oauth/consent?authorization_id=abc" }));
  });
  it("routes recovery without signup side effects", async () => { expect((await POST(request("recovery"))).headers.get("location")).toBe("https://curvi.ai/reset-password"); expect(state.finish).not.toHaveBeenCalled(); });
  it("accepts the first secure email link without a session", async () => {
    state.verify.mockResolvedValue({ data: { user: null }, error: null });
    expect((await POST(request("email_change"))).headers.get("location")).toContain("/app/settings"); expect(state.email).not.toHaveBeenCalled();
  });
  it("syncs a completed email change and tolerates a retryable billing failure", async () => {
    state.email.mockRejectedValueOnce(new Error("offline"));
    expect((await POST(request("email_change"))).headers.get("location")).toContain("/app/settings");
    expect(state.email).toHaveBeenCalled();
  });
  it("rejects replayed tokens, foreign origin and unsupported types", async () => {
    state.verify.mockResolvedValue({ data: { user: null }, error: { code: "otp_expired" } });
    expect((await POST(request())).headers.get("location")).toContain("error=link_invalid");
    vi.clearAllMocks(); expect((await POST(request("email", "https://evil.test"))).status).toBe(403);
    expect((await POST(request("invite"))).headers.get("location")).toContain("error=link_invalid"); expect(state.verify).not.toHaveBeenCalled();
  });
});
