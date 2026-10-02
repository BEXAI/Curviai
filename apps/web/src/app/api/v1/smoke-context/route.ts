/** Read-only proof that this key's own workspace is excluded from customer
 * metrics. Used before an explicitly authorized synthetic pack spends. */
import { NextResponse } from "next/server";
import { authorize } from "@/lib/api-v1/http";
import { SmokeContextResponse } from "@/lib/api-v1/schemas";
import { operatorWorkspaceIds } from "@/lib/customer-metrics";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authorize(request, "packs:read");
  if ("response" in auth) return auth.response;
  if (!isDbMode()) return NextResponse.json({ error: "The smoke workspace cannot be verified here.", reason: "unavailable" }, { status: 503, headers });
  try {
    const workspaceId = auth.caller.principal.workspaceId;
    const excluded = await operatorWorkspaceIds(getDb());
    if (!excluded.includes(workspaceId)) return NextResponse.json({ error: "This workspace is not configured for operator smoke.", reason: "not_operator_workspace" }, { status: 403, headers });
    return NextResponse.json(SmokeContextResponse.parse({ workspaceId, excluded: true }), { headers });
  } catch {
    return NextResponse.json({ error: "The smoke workspace could not be verified.", reason: "unavailable" }, { status: 503, headers });
  }
}
