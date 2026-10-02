import { beforeEach, describe, expect, it, vi } from "vitest";
const factorId = "10000000-0000-4000-8000-000000000001";
const state = vi.hoisted(() => ({
  session: null as unknown,
  audit: vi.fn(), notify: vi.fn(async () => ({ ok: true })), claim: vi.fn(async () => true), release: vi.fn(), limited: vi.fn(async () => null),
  enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), claims: vi.fn(), unenroll: vi.fn(),
}));
vi.mock("@/lib/operator-session", () => ({ getOperatorSession: async () => state.session }));
vi.mock("@/lib/ops/audit", () => ({ writeOpsAudit: state.audit }));
vi.mock("@/lib/rate-limit", () => ({ limitByUser: state.limited }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@curvi/trigger/cap-store", () => ({ PgCapStore: class { claim = state.claim; release = state.release; } }));
vi.mock("@curvi/trigger/spend-alerts", () => ({ sendFounderEmail: state.notify }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("404"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { enrollOperatorFactor, removeOperatorFactor, verifyOperatorFactor } from "./actions";
function operator(aal: "aal1" | "aal2", status?: "verified" | "unverified") {
  return { aal, hasVerifiedFactor: status === "verified", user: { id: "operator", email: "operator@example.com", factors: status ? [{ id: factorId, factor_type: "totp", status }] : [] }, supabase: { auth: { mfa: { enroll: state.enroll, challenge: state.challenge, verify: state.verify, unenroll: state.unenroll }, getClaims: state.claims } } };
}
beforeEach(() => {
  vi.clearAllMocks(); state.session = operator("aal1");
  state.enroll.mockResolvedValue({ data: { id: factorId, totp: { qr_code: "data:image/svg+xml;base64,PHN2Zz4=", secret: "setup-secret" } }, error: null });
  state.challenge.mockResolvedValue({ data: { id: "challenge" }, error: null }); state.verify.mockResolvedValue({ error: null }); state.unenroll.mockResolvedValue({ error: null });
  state.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal2" } }, error: null });
});
describe("operator MFA", () => {
  it("refuses an unverified operator session before touching MFA", async () => {
    state.session = null; await expect(enrollOperatorFactor()).rejects.toThrow("404"); expect(state.enroll).not.toHaveBeenCalled();
  });
  it("allows first enrollment at AAL1 with audits that contain no secret", async () => {
    const result = await enrollOperatorFactor(); expect(result.enrollment?.id).toBe(factorId);
    expect(state.audit).toHaveBeenCalledTimes(2); expect(JSON.stringify(state.audit.mock.calls)).not.toContain("setup-secret");
  });
  it("blocks new enrollment and removal at AAL1 when a verified factor exists", async () => {
    state.session = operator("aal1", "verified");
    expect((await enrollOperatorFactor()).error).toBeTruthy(); expect((await removeOperatorFactor(factorId)).error).toBeTruthy();
    expect(state.enroll).not.toHaveBeenCalled(); expect(state.unenroll).not.toHaveBeenCalled();
  });
  it("challenges only a factor belonging to the current operator", async () => {
    state.session = operator("aal1", "verified");
    expect((await verifyOperatorFactor("20000000-0000-4000-8000-000000000001", "123456")).error).toBeTruthy(); expect(state.challenge).not.toHaveBeenCalled();
    expect((await verifyOperatorFactor(factorId, "123456")).verified).toBe(true);
    expect(state.verify).toHaveBeenCalledWith({ factorId, challengeId: "challenge", code: "123456" }); expect(state.notify).not.toHaveBeenCalled();
  });
  it("refuses an unverified factor at AAL1 once another factor is verified", async () => {
    state.session = { ...operator("aal1", "unverified"), hasVerifiedFactor: true };
    expect((await verifyOperatorFactor(factorId, "123456")).error).toBeTruthy(); expect(state.challenge).not.toHaveBeenCalled();
  });
  it("verifies enrollment, requires signed AAL2 claims, audits and notifies once", async () => {
    state.session = operator("aal1", "unverified");
    expect((await verifyOperatorFactor(factorId, "123456")).verified).toBe(true);
    expect(state.audit).toHaveBeenCalledWith({}, expect.objectContaining({ action: "mfa.factor_added", targetId: factorId }));
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ text: "A sign in factor was added to the operator account operator@example.com." }));
    state.claim.mockResolvedValueOnce(false); await verifyOperatorFactor(factorId, "123456"); expect(state.notify).toHaveBeenCalledTimes(1);
    state.claims.mockResolvedValueOnce({ data: { claims: { sub: "other", aal: "aal2" } }, error: null });
    expect((await verifyOperatorFactor(factorId, "123456")).verified).not.toBe(true);
  });
  it("removes only at AAL2, records intent before mutation, then sends a notice", async () => {
    state.session = operator("aal2", "verified");
    expect((await removeOperatorFactor(factorId)).error).toBeUndefined();
    expect(state.audit.mock.invocationCallOrder[0]).toBeLessThan(state.unenroll.mock.invocationCallOrder[0]!);
    expect(state.audit).toHaveBeenCalledWith({}, expect.objectContaining({ action: "mfa.factor_removed" }));
    expect(state.notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("removed from") }));
  });
  it("does not change a factor if the audit trail is unavailable", async () => {
    state.audit.mockRejectedValueOnce(new Error("db unavailable"));
    expect((await enrollOperatorFactor()).error).toBeTruthy(); expect(state.enroll).not.toHaveBeenCalled();
  });
});
