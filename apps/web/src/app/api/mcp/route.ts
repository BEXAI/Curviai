/**
 * /api/mcp: the hosted Curvi MCP server (PHASE_16 workstream 5), Streamable
 * HTTP, POST only. Tools create_pack, get_pack, check_main_image and
 * list_channels, authenticated by a workspace API key sent as
 * Authorization: Bearer <key>, and, with MCP_OAUTH_ENABLED at "1", by an
 * OAuth access token from ChatGPT or Codex (PHASE_19, lib/mcp-auth), which
 * also gets get_profile. The protocol handling is in lib/api-v1/mcp.
 *
 * PHASE_19 P19-20: OPTIONS answers the CORS preflight for the allowed
 * origins, and every answer to an allowed browser origin carries the CORS
 * headers (lib/api-v1/mcp-cors).
 */

import { handleMcpPost, mcpMethodNotAllowed } from "@/lib/api-v1/mcp";
import { mcpPreflight, withMcpCors } from "@/lib/api-v1/mcp-cors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return withMcpCors(request, await handleMcpPost(request));
}

export async function GET(request: Request): Promise<Response> {
  return withMcpCors(request, mcpMethodNotAllowed());
}

export async function DELETE(request: Request): Promise<Response> {
  return withMcpCors(request, mcpMethodNotAllowed());
}

export async function OPTIONS(request: Request): Promise<Response> {
  return mcpPreflight(request);
}
