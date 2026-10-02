/**
 * One authenticator for /api/mcp while MCP_OAUTH_ENABLED is on (docs/phases/
 * PHASE_19.md, P19-08, "Token verification" and "Workspace scoping").
 *
 * - A bearer starting with cv_ takes the API key path, unchanged: same
 *   lookup, same Growth and up gate, same scopes. The lookup made before the
 *   body was read is reused, so a key is looked up once per request.
 * - Any other bearer is an OAuth access token from Supabase's OAuth server,
 *   verified by ./verify. The connection for (sub, client_id) decides the
 *   workspace; authorization never comes from tool arguments or client
 *   _meta hints. The membership and the workspace are read again on every
 *   call, so a member who leaves is refused at once (and their connection
 *   revoked, so the consent page asks for a workspace again), and a role
 *   change applies at once. The plan must include assistantAccess (seed).
 * - A verified token with no live connection gets one only when no row has
 *   ever existed for (user, client) and the user has exactly one workspace
 *   (consent that finished before its row write). Every other case answers
 *   "reconnect", which mcp.ts turns into the tool level challenge.
 *
 * The caller is the same ApiCaller the key path builds, with kind "oauth",
 * every internal scope, the user's rate subject, the connection id and
 * ipExempt (ChatGPT calls arrive from OpenAI's shared egress addresses).
 */

import type { JWTVerifyGetKey } from "jose";
import { API_AUTH_COPY, authenticateApiKey, type ApiAuthError, type ApiAuthResult, type ApiCaller } from "@/lib/api-keys/auth";
import { API_SCOPES, bearerKeyOf, type ApiScope } from "@/lib/api-keys/format";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { checkAssistantAccess, type AssistantAccessCheck } from "@/lib/entitlements";
import { DEMO_MODE_REFUSED_MESSAGE, DemoModeRefusedError } from "@/lib/services/demo-mode";
import { getMcpAuthBackend, type McpAuthBackend } from "./backend";
import { mcpOAuthConfig, type McpOAuthConfig } from "./config";
import { verifyAccessToken, type TokenFailureReason } from "./verify";

/** Milliseconds between last_used_at writes for one connection. */
export const CONNECTION_TOUCH_INTERVAL_MS = 60_000;

/** What signed in an OAuth caller, for get_profile (P19-11). Never used for
 * authorization. */
export interface McpOAuthIdentity {
  clientId: string;
  /** The user's stored profile_id: random, stable across reconnects. */
  profileId: string;
  /** The email claim of the token, or null. */
  email: string | null;
}

export type McpAuthFailure =
  /** No Authorization: Bearer header at all. */
  | { kind: "no_credential" }
  /** The API key path refused the key. */
  | { kind: "api_key"; error: ApiAuthError }
  /** The OAuth token failed verification. */
  | { kind: "token"; reason: Exclude<TokenFailureReason, "unavailable"> }
  /** A valid token with no live connection it may use. */
  | { kind: "reconnect" }
  /** The workspace's plan does not include assistant access. */
  | { kind: "not_in_plan"; message: string }
  /** Nothing could be checked right now. */
  | { kind: "unavailable"; message: string };

export type McpCredential = "none" | "api_key" | "oauth";

/** The identity behind each OAuth caller this process built, held apart from
 * ApiCaller so the shared caller shape stays as the key path makes it. */
const identities = new WeakMap<ApiCaller, McpOAuthIdentity>();

/** The OAuth identity of a caller authenticateMcp built, or null for an API
 * key caller (or any other caller). */
export function oauthIdentityOf(caller: ApiCaller): McpOAuthIdentity | null {
  return identities.get(caller) ?? null;
}

export type McpAuthResult =
  | { ok: true; caller: ApiCaller; identity: McpOAuthIdentity | null }
  | { ok: false; credential: McpCredential; failure: McpAuthFailure };

export interface AuthenticateMcpOptions {
  /** The API key lookup made before the body was read, or null when the
   * header held no well formed key. Undefined looks the key up here. */
  preAuth?: ApiAuthResult | null;
  /** The API key authenticator (tests swap it, as McpDeps.authenticate). */
  authenticateApiKey?: (headers: Headers, scope: ApiScope | null) => Promise<ApiAuthResult>;
  backend?: McpAuthBackend;
  config?: McpOAuthConfig;
  /** Replaces Supabase's remote JWKS (tests). */
  jwks?: JWTVerifyGetKey;
  /** The plan check; the seed's assistantAccess by default. */
  assistantAccess?: (plan: string) => AssistantAccessCheck;
  now?: Date;
}

function refused(credential: McpCredential, failure: McpAuthFailure): McpAuthResult {
  return { ok: false, credential, failure };
}

/** A scope free key answer narrowed to a tool's scope (as mcp.ts withScope). */
function keyResult(auth: ApiAuthResult, scope: ApiScope | null): McpAuthResult {
  if (!auth.ok) {
    return refused("api_key", { kind: "api_key", error: auth.error });
  }
  if (scope && !auth.caller.scopes.includes(scope)) {
    return refused("api_key", {
      kind: "api_key",
      error: { status: 403, reason: "insufficient_scope", message: API_AUTH_COPY.insufficient_scope },
    });
  }
  return { ok: true, caller: auth.caller, identity: null };
}

export async function authenticateMcp(
  headers: Headers,
  scope: ApiScope | null,
  options: AuthenticateMcpOptions = {},
): Promise<McpAuthResult> {
  const bearer = bearerKeyOf(headers);
  if (bearer === null) {
    return refused("none", { kind: "no_credential" });
  }
  if (bearer.startsWith("cv_")) {
    // Checked with no scope (once per request), then narrowed to the tool's.
    const auth = options.preAuth ?? (await (options.authenticateApiKey ?? authenticateApiKey)(headers, null));
    return keyResult(auth, scope);
  }
  return authenticateOAuthToken(bearer, options);
}

async function authenticateOAuthToken(token: string, options: AuthenticateMcpOptions): Promise<McpAuthResult> {
  const unavailable = (message: string = MCP_COPY.connectionUnavailable) =>
    refused("oauth", { kind: "unavailable", message });

  let backend: McpAuthBackend;
  try {
    backend = options.backend ?? getMcpAuthBackend();
  } catch (err) {
    if (err instanceof DemoModeRefusedError) {
      return unavailable(DEMO_MODE_REFUSED_MESSAGE);
    }
    throw err;
  }

  const config = options.config ?? mcpOAuthConfig();
  const verified = await verifyAccessToken(token, config, {
    sessions: backend.sessions,
    ...(options.jwks ? { jwks: options.jwks } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (!verified.ok) {
    return verified.reason === "unavailable" ? unavailable() : refused("oauth", { kind: "token", reason: verified.reason });
  }
  const { sub: userId, clientId, email } = verified.token;
  const now = options.now ?? new Date();

  try {
    let connection = await backend.connections.findLive(userId, clientId);
    if (!connection) {
      const workspaces = await backend.workspacesOf(userId);
      if (workspaces.length === 1 && workspaces[0]) {
        connection = await backend.connections.createFirst(
          { userId, oauthClientId: clientId, clientName: null, workspaceId: workspaces[0] },
          now,
        );
      }
      if (!connection) {
        return refused("oauth", { kind: "reconnect" });
      }
    }

    const principal = await backend.principal(userId, connection.workspaceId);
    if (!principal) {
      // The member left the workspace or it is gone. Revoke the row, so the
      // consent page shows the picker on the reconnect instead of following
      // a link back into a workspace this user cannot use.
      await backend.connections.revoke(connection.id, now);
      return refused("oauth", { kind: "reconnect" });
    }
    const access = (options.assistantAccess ?? checkAssistantAccess)(principal.plan);
    if (!access.ok) {
      return refused("oauth", { kind: "not_in_plan", message: access.message });
    }

    if (!connection.lastUsedAt || now.getTime() - connection.lastUsedAt.getTime() >= CONNECTION_TOUCH_INTERVAL_MS) {
      const id = connection.id;
      void backend.connections.touch(id, now).catch((err: unknown) => {
        console.warn(`[mcp-auth] could not record the use of connection ${id}`, err instanceof Error ? err.name : "error");
      });
    }

    const caller: ApiCaller = {
      kind: "oauth",
      keyId: null,
      prefix: null,
      connectionId: connection.id,
      ipExempt: true,
      scopes: [...API_SCOPES],
      principal,
      services: backend.servicesFor(principal, email),
      rateSubject: `user:${userId}`,
    };
    const identity: McpOAuthIdentity = { clientId, profileId: connection.profileId, email };
    identities.set(caller, identity);
    return { ok: true, caller, identity };
  } catch (err) {
    console.error("[mcp-auth] connection lookup failed", err instanceof Error ? err.name : "error");
    return unavailable();
  }
}
