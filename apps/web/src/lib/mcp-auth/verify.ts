/**
 * Verifies an OAuth access token from Supabase's OAuth 2.1 server for the
 * MCP server (docs/phases/PHASE_19.md, "Token verification", P19-07;
 * docs/verification.md, "PHASE_19": O1, O12, M1, SB1 to SB4 and jose).
 *
 * A token passes only when all of these hold, in this order:
 * - it is a compact JWS signed with ES256 or RS256 (HS256 refused) by a key
 *   in Supabase's JWKS ({issuer}/.well-known/jwks.json, cached by jose for
 *   10 minutes and refetched for an unknown kid at most every 30 seconds);
 * - iss equals the issuer and aud equals the MCP resource, which the Custom
 *   Access Token hook sets for OAuth tokens (migration 0028);
 * - exp and nbf hold with 30 seconds of tolerance, and sub is a user id;
 * - client_id is one of MCP_OAUTH_CLIENT_IDS (the audience binding rests on
 *   this list, because Supabase never binds the resource to the token);
 * - session_id is present, and scope (a space separated string, SB4
 *   tokens/service.go) holds openid and email;
 * - the session still exists (./sessions), so a revoked grant stops within
 *   the session cache minute.
 *
 * The token itself is never logged, echoed or forwarded (no passthrough,
 * M1); the only place it goes is Supabase's own Auth API when the session
 * check falls back to it.
 */

import { errors, createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { McpOAuthConfig } from "./config";
import type { SessionChecker } from "./sessions";

export type TokenFailureReason =
  | "invalid_token"
  | "expired"
  | "wrong_audience"
  | "unknown_client"
  | "session_ended"
  | "insufficient_scope"
  /** The token could not be checked right now (JWKS or session lookup
   * down, or the server is missing its issuer). Not the caller's fault. */
  | "unavailable";

export interface VerifiedToken {
  /** The Supabase user id. */
  sub: string;
  clientId: string;
  sessionId: string;
  scopes: string[];
  /** The email claim, or null. */
  email: string | null;
}

export type VerifyResult = { ok: true; token: VerifiedToken } | { ok: false; reason: TokenFailureReason };

export const ALLOWED_ALGORITHMS = ["ES256", "RS256"] as const;
export const CLOCK_TOLERANCE_SECONDS = 30;
/** Longest bearer the server parses; Supabase tokens are about 1 KB. */
export const MAX_TOKEN_LENGTH = 8_192;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const remoteSets = new Map<string, JWTVerifyGetKey>();

/** One jose remote key set per JWKS URL for the life of the process, so its
 * cache is shared by every request. */
export function remoteJwks(url: string): JWTVerifyGetKey {
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000 });
    remoteSets.set(url, set);
  }
  return set;
}

export interface VerifyDeps {
  sessions: SessionChecker;
  /** Replaces the remote JWKS (tests pass a local key set). */
  jwks?: JWTVerifyGetKey;
  /** The clock for exp and nbf (tests). */
  now?: Date;
}

function failureOf(err: unknown): TokenFailureReason {
  if (err instanceof errors.JWTExpired) {
    return "expired";
  }
  if (err instanceof errors.JWTClaimValidationFailed) {
    return err.claim === "aud" ? "wrong_audience" : "invalid_token";
  }
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) {
    return "unavailable";
  }
  if (err instanceof errors.JOSEError) {
    // The generic code is what a failed JWKS fetch throws ("Expected 200
    // OK", unparsable body); every token problem has its own subclass.
    return err.code === "ERR_JOSE_GENERIC" ? "unavailable" : "invalid_token";
  }
  // A network error from the JWKS fetch.
  return "unavailable";
}

/** The scopes of a space separated scope claim, or null when it is absent. */
export function scopesOf(payload: JWTPayload): string[] | null {
  const scope = payload.scope;
  if (typeof scope !== "string") {
    return null;
  }
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

export async function verifyAccessToken(
  token: string,
  config: Pick<McpOAuthConfig, "issuer" | "resource" | "clientIds" | "requiredScopes" | "jwksUrl">,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  if (!config.issuer || !config.resource || (!config.jwksUrl && !deps.jwks)) {
    return { ok: false, reason: "unavailable" };
  }
  if (token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) {
    return { ok: false, reason: "invalid_token" };
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, deps.jwks ?? remoteJwks(config.jwksUrl), {
      algorithms: [...ALLOWED_ALGORITHMS],
      issuer: config.issuer,
      audience: config.resource,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "exp"],
      ...(deps.now ? { currentDate: deps.now } : {}),
    });
    payload = verified.payload;
  } catch (err) {
    return { ok: false, reason: failureOf(err) };
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || !UUID.test(sub)) {
    return { ok: false, reason: "invalid_token" };
  }
  const clientId = payload.client_id;
  if (typeof clientId !== "string" || !config.clientIds.includes(clientId)) {
    return { ok: false, reason: "unknown_client" };
  }
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) {
    return { ok: false, reason: "invalid_token" };
  }
  const scopes = scopesOf(payload);
  if (!scopes || !config.requiredScopes.every((scope) => scopes.includes(scope))) {
    return { ok: false, reason: "insufficient_scope" };
  }

  const session = await deps.sessions.check(sessionId, sub, token);
  if (session === "ended") {
    return { ok: false, reason: "session_ended" };
  }
  if (session === "unknown") {
    return { ok: false, reason: "unavailable" };
  }

  return {
    ok: true,
    token: {
      sub,
      clientId,
      sessionId,
      scopes,
      email: typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null,
    },
  };
}
