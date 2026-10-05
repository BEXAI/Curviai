import { describe, expect, it, vi } from "vitest";
import { AUTH_NETWORK_ERROR } from "@/lib/auth-call";
import { changePassword, loadPasswordSession, sendPasswordCode, type PasswordAuth, type PasswordSession } from "./password-change";

const SESSION: PasswordSession = { userId: "test-user", sessionId: "test-session", recovery: false };
const INPUT = { password: " new-test-password ", currentPassword: " current-test-password ", nonce: " 123456 " };

function client(amr: unknown = [{ method: "password", timestamp: 1 }]) {
  return {
    getUser: vi.fn<PasswordAuth["getUser"]>().mockResolvedValue({ data: { user: { id: SESSION.userId } }, error: null }),
    getClaims: vi.fn<PasswordAuth["getClaims"]>().mockResolvedValue({
      data: { claims: { sub: SESSION.userId, session_id: SESSION.sessionId, amr } }, error: null,
    }),
    updateUser: vi.fn<PasswordAuth["updateUser"]>().mockResolvedValue({ error: null }),
    reauthenticate: vi.fn<PasswordAuth["reauthenticate"]>().mockResolvedValue({ error: null }),
  };
}

describe("verified password session", () => {
  it.each([[{ method: "recovery", timestamp: 1 }], ["recovery"]])("recognizes the verified password recovery AMR %j", async (entry) => {
    expect(await loadPasswordSession(client([entry]))).toEqual({ kind: "ready", session: { ...SESSION, recovery: true } });
  });

  it.each([undefined, [], ["otp"], ["magiclink"], ["mfa/recovery_code"], [{ method: "password" }], [null], { method: "recovery" }])(
    "does not treat missing, unrelated or malformed AMR as recovery: %j", async (amr) => {
      expect(await loadPasswordSession(client(amr))).toEqual({ kind: "ready", session: SESSION });
    },
  );

  it("requires a live user and matching verified identity/session", async () => {
    const auth = client();
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: "another-user", session_id: SESSION.sessionId, amr: ["recovery"] } }, error: null });
    expect(await loadPasswordSession(auth)).toEqual({ kind: "signedout" });
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: SESSION.userId, amr: ["recovery"] } }, error: null });
    expect(await loadPasswordSession(auth)).toEqual({ kind: "signedout" });
    auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await loadPasswordSession(auth)).toEqual({ kind: "signedout" });
  });

  it("leaves network verification failures retryable without a recovery session", async () => {
    const auth = client(["recovery"]);
    auth.getClaims.mockRejectedValue(new TypeError("private network detail"));
    expect(await loadPasswordSession(auth)).toEqual({ kind: "error", message: AUTH_NETWORK_ERROR, errorKind: "network" });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
});

describe("password updates", () => {
  it("preserves passwords exactly and forwards the entered verification code", async () => {
    const auth = client();
    expect(await changePassword(auth, SESSION, INPUT)).toEqual({ kind: "success" });
    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: INPUT.password, current_password: INPUT.currentPassword, nonce: "123456" });
    expect(auth.reauthenticate).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows password-only input for passwordless or recovery sessions (recovery=%s)", async (recovery) => {
    const auth = client(recovery ? ["recovery"] : ["oauth"]);
    expect(await changePassword(auth, { ...SESSION, recovery }, { password: INPUT.password, currentPassword: "", nonce: "" })).toEqual({ kind: "success" });
    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: INPUT.password });
  });

  it.each([
    ["current_password_required", "current_password", "Enter your current password to choose a new one."],
    ["current_password_mismatch", "current_password", "Your current password does not match. Try again or request a reset link."],
    ["reauthentication_needed", "nonce", "Verify it is you before changing your password. Request a verification code below."],
    ["reauthentication_not_valid", "nonce", "That verification code is invalid or expired. Try again or request a new code."],
  ])("handles provider requirement %s with fixed copy and no automatic email", async (code, required, message) => {
    const auth = client();
    auth.updateUser.mockResolvedValue({ error: { code } });
    expect(await changePassword(auth, SESSION, INPUT)).toEqual({ kind: "error", errorKind: "rejected", message, required });
    expect(auth.reauthenticate).not.toHaveBeenCalled();
  });

  it("never submits passwords or sends a code after the account/session changed", async () => {
    const auth = client();
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: SESSION.userId, session_id: "new-session", amr: ["password"] } }, error: null });
    const expected = { kind: "changed", session: { ...SESSION, sessionId: "new-session" } };
    expect(await changePassword(auth, SESSION, INPUT)).toEqual(expected);
    expect(await sendPasswordCode(auth, SESSION)).toEqual(expected);
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.reauthenticate).not.toHaveBeenCalled();
  });

  it("cancels before either mutation when a pending session check was invalidated", async () => {
    const auth = client();
    expect(await changePassword(auth, SESSION, INPUT, () => false)).toEqual({ kind: "cancelled" });
    expect(await sendPasswordCode(auth, SESSION, () => false)).toEqual({ kind: "cancelled" });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.reauthenticate).not.toHaveBeenCalled();
  });

  it("sends a code only on an explicit request and handles send/network failures", async () => {
    const auth = client();
    expect(await sendPasswordCode(auth, SESSION)).toEqual({ kind: "success" });
    expect(auth.reauthenticate).toHaveBeenCalledTimes(1);
    auth.reauthenticate.mockRejectedValue(new Error("private server detail"));
    expect(await sendPasswordCode(auth, SESSION)).toEqual({ kind: "error", message: AUTH_NETWORK_ERROR, errorKind: "network" });
    auth.updateUser.mockRejectedValue(new Error("private password detail"));
    expect(await changePassword(auth, SESSION, INPUT)).toMatchObject({ kind: "error", message: AUTH_NETWORK_ERROR, errorKind: "network" });
  });
});
