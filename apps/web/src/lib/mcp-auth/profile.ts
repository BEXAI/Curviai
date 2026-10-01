/**
 * get_profile (PHASE_19 P19-11, filled on p19/auth): the Curvi account and
 * workspace behind an OAuth connection, as a ProfileChat with the member's
 * stored profile_id (OpenAI O1: an opaque id kept across token refresh and
 * reconnection). Wave 0 (P19-02) leaves this stub so the tool definition in
 * lib/api-v1/mcp-tools.ts exists; the tool is not listed, and so cannot be
 * called, until P19-11 sets GET_PROFILE_LISTED.
 */

import { errorResult, type ApiContext, type ApiResult } from "@/lib/api-v1/actions";

/** Whether tools/list offers get_profile. P19-11 turns it on. */
export const GET_PROFILE_LISTED: boolean = false;

export async function getProfile(_ctx: ApiContext): Promise<ApiResult> {
  return errorResult(404, "not_found", "This is not available yet.");
}
