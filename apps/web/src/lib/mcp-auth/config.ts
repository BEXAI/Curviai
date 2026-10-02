/**
 * Sign in settings for the MCP server's OAuth path (docs/phases/PHASE_19.md,
 * "Sign in design" and "Environment variables"). Read at call time, like
 * every env read in the app (lib/env.ts), so a Render env change and a
 * restart switch the path without a build.
 *
 * MCP_OAUTH_ENABLED is the kill switch: anything but "1" keeps /api/mcp
 * exactly as it was before PHASE_19 (API keys only, discovery open, no
 * metadata documents), which is the rollback.
 */

import { optionalEnv, siteUrl } from "@/lib/env";

/** The OIDC scopes the MCP server needs. Supabase's OAuth server accepts only
 * OIDC scopes (docs/verification.md, "PHASE_19", SB4 oauth_scope.go), so
 * Curvi enforces its own permissions in code; these two let the server know
 * who the user is. offline_access stays out of the metadata and the
 * challenge (MCP authorization, M1). */
export const MCP_REQUIRED_SCOPES = ["openid", "email"] as const;

export interface McpOAuthConfig {
  /** The canonical resource: the URL users paste, byte for byte. */
  resource: string;
  /** Supabase Auth's issuer, byte for byte as its metadata names it. */
  issuer: string;
  /** Supabase OAuth client ids allowed to call the MCP server. The audience
   * binding rests on this list, because Supabase never binds the resource
   * parameter to the token (SB4); the hook sets a fixed aud. */
  clientIds: readonly string[];
  /** Scopes every token must carry. */
  requiredScopes: readonly string[];
  /** The protected resource metadata URL (RFC 9728, path form). */
  resourceMetadataUrl: string;
  /** Supabase's JWKS for the issuer. */
  jwksUrl: string;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** True when MCP_OAUTH_ENABLED is "1". */
export function mcpOAuthEnabled(): boolean {
  return optionalEnv("MCP_OAUTH_ENABLED") === "1";
}

/** The canonical resource URL: MCP_RESOURCE_URL, else the site's /api/mcp. */
export function mcpResourceUrl(): string {
  return optionalEnv("MCP_RESOURCE_URL") ?? `${withoutTrailingSlash(siteUrl())}/api/mcp`;
}

/** RFC 9728 path form: the well known prefix inserted before the resource's
 * path, so https://curvi.ai/api/mcp has its metadata at
 * https://curvi.ai/.well-known/oauth-protected-resource/api/mcp. */
export function resourceMetadataUrlFor(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : withoutTrailingSlash(url.pathname);
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Parses MCP_OAUTH_CLIENT_IDS: a comma list, blanks dropped. */
export function parseClientIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function mcpOAuthConfig(): McpOAuthConfig {
  const resource = mcpResourceUrl();
  const supabaseUrl = optionalEnv("NEXT_PUBLIC_SUPABASE_URL");
  const issuer =
    optionalEnv("SUPABASE_AUTH_ISSUER") ?? (supabaseUrl ? `${withoutTrailingSlash(supabaseUrl)}/auth/v1` : "");
  return {
    resource,
    issuer,
    clientIds: parseClientIds(optionalEnv("MCP_OAUTH_CLIENT_IDS")),
    requiredScopes: MCP_REQUIRED_SCOPES,
    resourceMetadataUrl: resourceMetadataUrlFor(resource),
    jwksUrl: issuer ? `${withoutTrailingSlash(issuer)}/.well-known/jwks.json` : "",
  };
}
