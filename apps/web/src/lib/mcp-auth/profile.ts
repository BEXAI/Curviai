/**
 * get_profile (docs/phases/PHASE_19.md, P19-11; docs/verification.md,
 * "PHASE_19", O1 and O2): the Curvi account and workspace behind an OAuth
 * connection, so ChatGPT can tell which account it is using.
 *
 * - id is the user's stored profile_id from mcp_connections: 16 random
 *   bytes, made once per user and copied into every later row, so it stays
 *   the same across token refreshes, reconnects and workspace changes, and
 *   it is never derived from a secret or from the user, workspace or
 *   connection id (O1: "assign an opaque ID once, persist its association").
 * - name is the workspace name and email the token's email claim, read from
 *   the connection and the workspace on this call.
 *
 * The tool is listed (GET_PROFILE_LISTED) and its descriptor lives with the
 * other tools in lib/api-v1/mcp-tools.ts (GET_PROFILE_TOOL, which P19-13
 * gives `_meta["openai/profile"]: true` and the ProfileChat outputSchema).
 * mcp.ts offers it only to OAuth callers: API key clients see the tool list
 * they saw before PHASE_19, and with MCP_OAUTH_ENABLED off nobody sees it.
 * The result is a ProfileChat; toolResult adds the same object serialized as
 * JSON in a text block, as O1 asks.
 */

import { errorResult, type ApiContext, type ApiResult } from "@/lib/api-v1/actions";
import { ProfileChat } from "@/lib/api-v1/chat-views";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { oauthIdentityOf } from "./authenticate";

/** Whether the tool list holds get_profile (mcp.ts still offers it to OAuth
 * callers only). */
export const GET_PROFILE_LISTED: boolean = true;

/** The descriptor _meta the profile tool carries (O1, O2), for P19-13 to
 * merge into GET_PROFILE_TOOL's descriptor. */
export const GET_PROFILE_META = { "openai/profile": true } as const;

export async function getProfile(ctx: ApiContext): Promise<ApiResult> {
  const identity = ctx.caller.kind === "oauth" ? oauthIdentityOf(ctx.caller) : null;
  if (!identity) {
    return errorResult(403, "oauth_only", MCP_COPY.connectAccount);
  }
  const profile: ProfileChat = ProfileChat.parse({
    id: identity.profileId,
    name: ctx.caller.principal.workspaceName,
    ...(identity.email ? { email: identity.email } : {}),
  });
  return { status: 200, body: profile };
}
