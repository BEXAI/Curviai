import { describe, expect, it } from "vitest";
import { AUTH_GENERIC_ERROR, AUTH_NETWORK_ERROR, isNetworkAuthError, runAuthCall, trackAuthError } from "./auth-call";

// Update.md 6.11: every failure mode of an auth call ends in a message, so
// the form leaves its busy state.
describe("runAuthCall", () => {
  it("returns the value when the call succeeds", async () => {
    const result = await runAuthCall(async () => ({ data: { session: null }, error: null }));
    expect(result).toEqual({ ok: true, value: { data: { session: null }, error: null } });
  });

  it("turns a thrown fetch into the network message", async () => {
    const result = await runAuthCall(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, message: AUTH_NETWORK_ERROR, kind: "network" });
  });

  it("turns a retryable fetch error value into the network message", async () => {
    const result = await runAuthCall(async () => ({
      error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 },
    }));
    expect(result).toEqual({ ok: false, message: AUTH_NETWORK_ERROR, kind: "network" });
    const unavailable = await runAuthCall(async () => ({
      error: { name: "AuthRetryableFetchError", message: "Service Unavailable", status: 503 },
    }));
    expect(unavailable).toEqual({ ok: false, message: AUTH_NETWORK_ERROR, kind: "network" });
  });

  it("maps an auth code without exposing the provider message", async () => {
    const result = await runAuthCall(async () => ({
      error: { code: "invalid_credentials", name: "AuthApiError", message: "private provider detail", status: 400 },
    }));
    expect(result).toEqual({ ok: false, message: "That email and password do not match. Try again or reset your password.", kind: "rejected" });
  });

  it("uses a generic message when the rejection has no text", async () => {
    const result = await runAuthCall(async () => ({ error: { name: "AuthApiError", message: "", status: 400 } }));
    expect(result).toEqual({ ok: false, message: AUTH_GENERIC_ERROR, kind: "rejected" });
  });
});

describe("isNetworkAuthError", () => {
  it("recognizes only unreachable server errors", () => {
    expect(isNetworkAuthError({ name: "AuthRetryableFetchError", status: 504 })).toBe(true);
    expect(isNetworkAuthError({ name: "AuthUnknownError", status: 0 })).toBe(true);
    expect(isNetworkAuthError({ name: "AuthApiError", status: 422 })).toBe(false);
    expect(isNetworkAuthError(null)).toBe(false);
  });
});

describe("trackAuthError", () => {
  it("is a no op outside the browser", () => {
    expect(() => trackAuthError("login", "network")).not.toThrow();
  });
});
