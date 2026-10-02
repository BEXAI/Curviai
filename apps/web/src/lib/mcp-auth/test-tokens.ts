/**
 * Test only: an ES256 key pair, a local JWKS standing in for Supabase's, and
 * access tokens shaped like the ones Supabase's OAuth server issues once the
 * Custom Access Token hook has set aud (docs/verification.md, "PHASE_19",
 * SB2 and SB4 tokens/service.go). Nothing in the app imports it.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { McpOAuthConfig } from "./config";
import { resourceMetadataUrlFor } from "./config";

export const TEST_ISSUER = "https://project.supabase.co/auth/v1";
export const TEST_RESOURCE = "https://curvi.ai/api/mcp";
export const TEST_CLIENT_ID = "11111111-2222-4333-8444-555555555555";
export const TEST_OTHER_CLIENT_ID = "99999999-2222-4333-8444-555555555555";
export const TEST_USER_ID = "00000000-0000-4000-8000-000000000201";
export const TEST_SESSION_ID = "22222222-3333-4444-8555-666666666666";

export const TEST_CONFIG: McpOAuthConfig = {
  resource: TEST_RESOURCE,
  issuer: TEST_ISSUER,
  clientIds: [TEST_CLIENT_ID],
  requiredScopes: ["openid", "email"],
  resourceMetadataUrl: resourceMetadataUrlFor(TEST_RESOURCE),
  jwksUrl: `${TEST_ISSUER}/.well-known/jwks.json`,
};

export interface TestKeys {
  jwks: JWTVerifyGetKey;
  /** Signs claims with the published key (kid "test-current"). */
  sign(claims: JWTPayload, options?: { expiresIn?: string | number; notBefore?: string | number; issuedAt?: number }): Promise<string>;
  /** Signs with a key that is not in the JWKS (kid "test-unknown"). */
  signUnknown(claims: JWTPayload): Promise<string>;
}

/** The claims of an OAuth access token for TEST_USER_ID through ChatGPT. */
export function oauthClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: TEST_ISSUER,
    aud: TEST_RESOURCE,
    sub: TEST_USER_ID,
    role: "authenticated",
    email: "seller@example.com",
    phone: "",
    aal: "aal1",
    session_id: TEST_SESSION_ID,
    is_anonymous: false,
    client_id: TEST_CLIENT_ID,
    scope: "openid email profile phone offline_access",
    ...overrides,
  };
}

export async function testKeys(): Promise<TestKeys> {
  const current = await generateKeyPair("ES256", { extractable: true });
  const unknown = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(current.publicKey)), kid: "test-current", alg: "ES256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  async function signWith(key: CryptoKey, kid: string, claims: JWTPayload, options: Parameters<TestKeys["sign"]>[1] = {}) {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid, typ: "JWT" });
    jwt.setIssuedAt(options.issuedAt);
    if (claims.exp === undefined) {
      jwt.setExpirationTime(options.expiresIn ?? "1h");
    }
    if (options.notBefore !== undefined) {
      jwt.setNotBefore(options.notBefore);
    }
    return jwt.sign(key);
  }

  return {
    jwks,
    sign: (claims, options) => signWith(current.privateKey, "test-current", claims, options),
    signUnknown: (claims) => signWith(unknown.privateKey, "test-unknown", claims),
  };
}

/** An HS256 token with the same claims, signed with a shared secret. */
export async function hs256Token(claims: JWTPayload): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-legacy-shared-secret-of-enough-length"));
}
