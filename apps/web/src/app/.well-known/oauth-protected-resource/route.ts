/**
 * /.well-known/oauth-protected-resource: the protected resource metadata
 * (RFC 9728) for the MCP server at /api/mcp (docs/phases/PHASE_19.md, P19-06).
 * The same document as the path form under ./api/mcp, which clients try
 * first. 404 while MCP_OAUTH_ENABLED is off.
 */

import { protectedResourcePreflight, protectedResourceResponse } from "@/lib/mcp-auth/challenge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return protectedResourceResponse();
}

export async function OPTIONS(): Promise<Response> {
  return protectedResourcePreflight();
}
