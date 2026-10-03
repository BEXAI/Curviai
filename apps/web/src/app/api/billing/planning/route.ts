import { NextResponse } from "next/server";
import { resolveSignedIn } from "@/lib/http/services";
import { canManageBilling } from "@/lib/billing/access";
import { readCreditPlanning, demoCreditPlanning } from "@/lib/billing/credit-planning";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const resolved = await resolveSignedIn("Sign in to see credit planning.");
  if ("response" in resolved) return resolved.response;
  if (!canManageBilling(resolved.workspace.role)) return NextResponse.json({ error: "Only the workspace owner or an admin can see credit planning." }, { status: 403 });
  const view = isDbMode() ? await readCreditPlanning(getDb(), resolved.workspace.id) : demoCreditPlanning(resolved.workspace.creditBalance);
  return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store" } });
}
