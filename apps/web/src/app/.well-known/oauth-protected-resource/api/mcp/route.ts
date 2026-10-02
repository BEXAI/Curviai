/**
 * /.well-known/oauth-protected-resource/api/mcp: the path form of the
 * protected resource metadata (RFC 9728) for https://curvi.ai/api/mcp, which
 * MCP clients try first (docs/phases/PHASE_19.md, P19-06). 404 while
 * MCP_OAUTH_ENABLED is off.
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
