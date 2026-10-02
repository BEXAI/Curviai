/**
 * What the MCP server tells a client that must sign in (docs/phases/
 * PHASE_19.md, "Metadata endpoints"; docs/verification.md, "PHASE_19", O1,
 * O2 and M1):
 *
 * - the protected resource metadata document (RFC 9728) served at
 *   /.well-known/oauth-protected-resource and its /api/mcp path form;
 * - the HTTP 401 challenge, `Bearer resource_metadata="...",
 *   scope="openid email"`, plus `error="invalid_token"` and a description
 *   when a token was sent and failed (403 and `insufficient_scope` when its
 *   scopes fall short);
 * - the tool level challenge OpenAI documents: an isError tool result whose
 *   `_meta["mcp/www_authenticate"]` holds the RFC 7235 challenge, which tells
 *   ChatGPT to run the sign in again. The plain RFC 7235 string is used; the
 *   extra single quotes in OpenAI's example look like a doc artifact
 *   (verification row "Tool level auth error", checked live in P19-12).
 */

import { siteUrl } from "@/lib/env";
import { mcpOAuthConfig, mcpOAuthEnabled, type McpOAuthConfig } from "./config";

export const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

export type ChallengeError = "invalid_token" | "insufficient_scope";

/** RFC 6750 quoted strings allow no double quote, no backslash and nothing
 * outside printable ASCII. */
function quoted(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]/g, " ").replace(/["\\]/g, "'")}"`;
}

export interface ChallengeOptions {
  error?: ChallengeError;
  description?: string;
  /** Include scope (the HTTP challenge does; the tool level one follows
   * O1's example, which names only resource_metadata and the error). */
  scope?: boolean;
}

/** The WWW-Authenticate value for this resource. */
export function challengeHeader(config: Pick<McpOAuthConfig, "resourceMetadataUrl" | "requiredScopes">, options: ChallengeOptions = {}): string {
  const parts = [`resource_metadata=${quoted(config.resourceMetadataUrl)}`];
  if (options.scope !== false) {
    parts.push(`scope=${quoted(config.requiredScopes.join(" "))}`);
  }
  if (options.error) {
    parts.push(`error=${quoted(options.error)}`);
    if (options.description) {
      parts.push(`error_description=${quoted(options.description)}`);
    }
  }
  return `Bearer ${parts.join(", ")}`;
}

/** The tool level challenge result (O1): text only, no structuredContent. */
export function toolChallengeResult(
  config: Pick<McpOAuthConfig, "resourceMetadataUrl" | "requiredScopes">,
  message: string,
): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    _meta: {
      [WWW_AUTHENTICATE_META]: [challengeHeader(config, { error: "invalid_token", description: message, scope: false })],
    },
  };
}

/** The protected resource metadata (RFC 9728) for the MCP resource. */
export function protectedResourceMetadata(config: Pick<McpOAuthConfig, "resource" | "issuer" | "requiredScopes">): Record<string, unknown> {
  const site = siteUrl().replace(/\/+$/, "");
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...config.requiredScopes],
    bearer_methods_supported: ["header"],
    resource_documentation: `${site}/help#use-curvi-in-chatgpt`,
    resource_policy_uri: `${site}/privacy`,
    resource_tos_uri: `${site}/terms`,
  };
}

const METADATA_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
  "Access-Control-Allow-Origin": "*",
} as const;

/** GET on either metadata path. 404 while MCP_OAUTH_ENABLED is off, so the
 * dark deploy advertises no sign in (the paths 404 today). */
export function protectedResourceResponse(): Response {
  if (!mcpOAuthEnabled()) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(JSON.stringify(protectedResourceMetadata(mcpOAuthConfig())), { status: 200, headers: METADATA_HEADERS });
}

/** CORS preflight for browser based MCP clients such as the Inspector. */
export function protectedResourcePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "MCP-Protocol-Version",
      "Access-Control-Max-Age": "3600",
    },
  });
}
