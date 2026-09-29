/**
 * /api/mcp: the hosted Curvi MCP server (PHASE_16 workstream 5), Streamable
 * HTTP, POST only. Tools create_pack, get_pack, check_main_image and
 * list_channels, authenticated by a workspace API key sent as
 * Authorization: Bearer <key>. The protocol handling is in lib/api-v1/mcp.
 */

import { handleMcpPost, mcpMethodNotAllowed } from "@/lib/api-v1/mcp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMcpPost(request);
}

export async function GET(): Promise<Response> {
  return mcpMethodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return mcpMethodNotAllowed();
}
