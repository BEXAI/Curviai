import { beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { createTestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { AuthApiSessionChecker, CachedSessionChecker, DbSessionChecker, type SessionChecker, type SessionState } from "./sessions";
import { TEST_CLIENT_ID, TEST_CONFIG, TEST_OTHER_CLIENT_ID, TEST_SESSION_ID, TEST_USER_ID, hs256Token, oauthClaims, testKeys, type TestKeys } from "./test-tokens";
import { verifyAccessToken, type TokenFailureReason } from "./verify";

// Token verification for the MCP server's OAuth path (docs/phases/
// PHASE_19.md, "Token verification", P19-07): a generated ES256 key pair
// stands in for Supabase's signing key and a local key set for its JWKS.

let keys: TestKeys;
const alive: SessionChecker = { check: async () => "alive" };

function sessions(state: SessionState): SessionChecker {
  return { check: async () => state };
}

async function reasonOf(token: string, checker: SessionChecker = alive): Promise<TokenFailureReason | "ok"> {
  const result = await verifyAccessToken(token, TEST_CONFIG, { sessions: checker, jwks: keys.jwks });
  return result.ok ? "ok" : result.reason;
}

beforeAll(async () => {
  keys = await testKeys();
});

describe("verifyAccessToken", () => {
  it("accepts a token from Supabase's OAuth server for an allowlisted client", async () => {
    const check = vi.fn(async () => "alive" as const);
    const token = await keys.sign(oauthClaims());
    const result = await verifyAccessToken(token, TEST_CONFIG, { sessions: { check }, jwks: keys.jwks });
    expect(result).toEqual({
      ok: true,
      token: {
        sub: TEST_USER_ID,
        clientId: TEST_CLIENT_ID,
        sessionId: TEST_SESSION_ID,
        scopes: ["openid", "email", "profile", "phone", "offline_access"],
        email: "seller@example.com",
      },
    });
    expect(check).toHaveBeenCalledWith(TEST_SESSION_ID, TEST_USER_ID, token);
  });

  it("accepts RS256 as well as ES256", async () => {
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "rsa", alg: "RS256" }] });
    const token = await new SignJWT(oauthClaims()).setProtectedHeader({ alg: "RS256", kid: "rsa" }).setIssuedAt().setExpirationTime("1h").sign(rsa.privateKey);
    const result = await verifyAccessToken(token, TEST_CONFIG, { sessions: alive, jwks });
    expect(result.ok).toBe(true);
  });

  it.each<[string, () => Promise<string>, TokenFailureReason]>([
    ["a wrong issuer", () => keys.sign(oauthClaims({ iss: "https://other.supabase.co/auth/v1" })), "invalid_token"],
    ["aud authenticated (a web session, or the hook is off)", () => keys.sign(oauthClaims({ aud: "authenticated" })), "wrong_audience"],
    ["another audience", () => keys.sign(oauthClaims({ aud: "https://evil.example/mcp" })), "wrong_audience"],
    ["an expired token", () => keys.sign(oauthClaims({ exp: Math.floor(Date.now() / 1000) - 120 })), "expired"],
    ["nbf in the future", () => keys.sign(oauthClaims(), { notBefore: Math.floor(Date.now() / 1000) + 600 }), "invalid_token"],
    ["HS256", () => hs256Token(oauthClaims()), "invalid_token"],
    ["an unknown kid", () => keys.signUnknown(oauthClaims()), "invalid_token"],
    ["no client_id", () => keys.sign(oauthClaims({ client_id: undefined })), "unknown_client"],
    ["a client that is not allowlisted", () => keys.sign(oauthClaims({ client_id: TEST_OTHER_CLIENT_ID })), "unknown_client"],
    ["no session_id", () => keys.sign(oauthClaims({ session_id: undefined })), "invalid_token"],
    ["a sub that is not a user id", () => keys.sign(oauthClaims({ sub: "service" })), "invalid_token"],
    ["a scope without email", () => keys.sign(oauthClaims({ scope: "openid profile" })), "insufficient_scope"],
    ["no scope claim", () => keys.sign(oauthClaims({ scope: undefined })), "insufficient_scope"],
    ["a scope claim that is not a string", () => keys.sign(oauthClaims({ scope: ["openid", "email"] })), "insufficient_scope"],
  ])("refuses %s", async (_name, make, reason) => {
    expect(await reasonOf(await make())).toBe(reason);
  });

  it("accepts a token within 30 seconds of its expiry or start", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await reasonOf(await keys.sign(oauthClaims({ exp: now - 10 })))).toBe("ok");
    expect(await reasonOf(await keys.sign(oauthClaims(), { notBefore: now + 10 }))).toBe("ok");
  });

  it("refuses a token whose session is gone, and answers unavailable when it cannot tell", async () => {
    const token = await keys.sign(oauthClaims());
    expect(await reasonOf(token, sessions("ended"))).toBe("session_ended");
    expect(await reasonOf(token, sessions("unknown"))).toBe("unavailable");
  });

  it("refuses garbage, a tampered signature and an oversized bearer without a key lookup", async () => {
    const jwks = vi.fn(keys.jwks);
    const token = await keys.sign(oauthClaims());
    const [header, payload] = token.split(".");
    const forged = `${header}.${Buffer.from(JSON.stringify(oauthClaims({ sub: "00000000-0000-4000-8000-0000000000ff" }))).toString("base64url")}.${token.split(".")[2]}`;
    for (const bad of ["not-a-jwt", `${header}.${payload}`, "a".repeat(9000)]) {
      const result = await verifyAccessToken(bad, TEST_CONFIG, { sessions: alive, jwks });
      expect(result).toEqual({ ok: false, reason: "invalid_token" });
    }
    expect(jwks).not.toHaveBeenCalled();
    expect(await reasonOf(forged)).toBe("invalid_token");
  });

  it("answers unavailable when the key set cannot be fetched or the issuer is not configured", async () => {
    const token = await keys.sign(oauthClaims());
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await verifyAccessToken(token, TEST_CONFIG, { sessions: alive, jwks: down })).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyAccessToken(token, { ...TEST_CONFIG, issuer: "" }, { sessions: alive, jwks: keys.jwks })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("never checks the session of a token that failed", async () => {
    const check = vi.fn(async () => "alive" as const);
    await verifyAccessToken(await keys.sign(oauthClaims({ client_id: TEST_OTHER_CLIENT_ID })), TEST_CONFIG, { sessions: { check }, jwks: keys.jwks });
    expect(check).not.toHaveBeenCalled();
  });
});

describe("session checks", () => {
  it("caches definite answers for 60 seconds per session, never unknown, within a bound", async () => {
    let now = 0;
    let state: SessionState = "alive";
    const inner = { check: vi.fn(async () => state) };
    const cached = new CachedSessionChecker(inner, () => now, 60_000, 2);
    expect(await cached.check("s1", "u", "t")).toBe("alive");
    state = "ended";
    now = 59_000;
    expect(await cached.check("s1", "u", "t")).toBe("alive");
    now = 60_000;
    expect(await cached.check("s1", "u", "t")).toBe("ended");
    expect(inner.check).toHaveBeenCalledTimes(2);

    state = "unknown";
    expect(await cached.check("s2", "u", "t")).toBe("unknown");
    expect(await cached.check("s2", "u", "t")).toBe("unknown");
    expect(inner.check).toHaveBeenCalledTimes(4);

    state = "alive";
    await cached.check("s3", "u", "t");
    await cached.check("s4", "u", "t");
    expect(cached.size).toBe(2);
  });

  it("asks Supabase's GET /user with the token, the anon key and X-JWT-AUD set to the resource", async () => {
    const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
    const checker = new AuthApiSessionChecker({
      issuer: "https://project.supabase.co/auth/v1/",
      anonKey: "anon-key",
      audience: "https://curvi.ai/api/mcp",
      fetch: fetchStub as unknown as typeof fetch,
    });
    expect(await checker.check("s", "u", "the-token")).toBe("alive");
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe("https://project.supabase.co/auth/v1/user");
    expect(init.headers).toEqual({ Authorization: "Bearer the-token", apikey: "anon-key", "X-JWT-AUD": "https://curvi.ai/api/mcp" });

    const answer = (status: number, body: unknown) =>
      new AuthApiSessionChecker({
        issuer: "https://project.supabase.co/auth/v1",
        anonKey: "anon-key",
        audience: "x",
        fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
      }).check("s", "u", "t");
    expect(await answer(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" })).toBe("ended");
    expect(await answer(403, { error_code: "user_banned" })).toBe("ended");
    expect(await answer(401, { error_code: "bad_jwt" })).toBe("unknown");
    expect(await answer(500, {})).toBe("unknown");
    expect(
      await new AuthApiSessionChecker({ issuer: "", anonKey: "", audience: "x", fetch: fetchStub as unknown as typeof fetch }).check("s", "u", "t"),
    ).toBe("unknown");
  });

  it("reads auth.sessions over the owner connection", async () => {
    const { client, db } = await createTestDb();
    await client.exec(`
      create table auth.sessions (id uuid primary key, user_id uuid not null, not_after timestamptz);
      insert into auth.sessions (id, user_id, not_after) values
        ('${TEST_SESSION_ID}', '${TEST_USER_ID}', null),
        ('33333333-3333-4444-8555-666666666666', '${TEST_USER_ID}', now() - interval '1 minute');
    `);
    const fallback = { check: vi.fn(async () => "alive" as const) };
    const checker = new DbSessionChecker(db as unknown as Db, fallback);
    expect(await checker.check(TEST_SESSION_ID, TEST_USER_ID, "t")).toBe("alive");
    expect(await checker.check(TEST_SESSION_ID, "00000000-0000-4000-8000-0000000000ff", "t")).toBe("ended");
    expect(await checker.check("33333333-3333-4444-8555-666666666666", TEST_USER_ID, "t")).toBe("ended");
    expect(await checker.check("44444444-3333-4444-8555-666666666666", TEST_USER_ID, "t")).toBe("ended");
    expect(fallback.check).not.toHaveBeenCalled();
    await client.close();
  });

  it("switches to the Auth API for good when the owner role cannot read auth.sessions", async () => {
    const { client, db } = await createTestDb();
    const fallback = { check: vi.fn(async () => "alive" as const) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const checker = new DbSessionChecker(db as unknown as Db, fallback);
    // createTestDb has no auth.sessions table: 42P01.
    expect(await checker.check(TEST_SESSION_ID, TEST_USER_ID, "t")).toBe("alive");
    expect(await checker.check(TEST_SESSION_ID, TEST_USER_ID, "t")).toBe("alive");
    expect(fallback.check).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("t\"");
    warn.mockRestore();

    const failing = new DbSessionChecker({ execute: async () => Promise.reject(Object.assign(new Error("boom"), { code: "57P01" })) } as unknown as Db, fallback);
    expect(await failing.check(TEST_SESSION_ID, TEST_USER_ID, "t")).toBe("unknown");
    await client.close();
  });
});
