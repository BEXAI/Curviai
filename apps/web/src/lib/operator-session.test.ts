import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "operator", email: "ops@curvi.ai", email_confirmed_at: "2026-10-02", factors: [{ status: "verified" }] },
  claims: { sub: "operator", aal: "aal2" },
  claimError: null as null | Error,
  userError: null as null | Error,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: state.user }, error: state.userError }),
    getClaims: async () => ({ data: { claims: state.claims }, error: state.claimError }),
  } }),
}));
import { getOperatorSession } from "./operator-session";

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", "ops@curvi.ai");
  state.claims = { sub: "operator", aal: "aal2" };
  state.claimError = null;
  state.userError = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("verified operator sessions", () => {
  it("trusts the assurance level only after account and token verification", async () => {
    expect(await getOperatorSession()).toMatchObject({ aal: "aal2", hasVerifiedFactor: true });
    state.claimError = new Error("signature verification failed");
    expect(await getOperatorSession()).toBeNull();
  });
  it("refuses a valid token for a different account and unknown assurance levels", async () => {
    state.claims.sub = "another-account";
    expect(await getOperatorSession()).toBeNull();
    state.claims = { sub: "operator", aal: "aal3" };
    expect(await getOperatorSession()).toBeNull();
  });
  it("refuses a revoked or unavailable account despite an otherwise valid token", async () => {
    state.userError = new Error("session revoked");
    expect(await getOperatorSession()).toBeNull();
  });
});
