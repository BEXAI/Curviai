import { NextResponse } from "next/server";
import { resolveSignedIn } from "@/lib/http/services";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { creditHistoryCsv, demoCreditHistory, historyCursor, listCreditHistory } from "@/lib/billing/history";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const resolved = await resolveSignedIn("Sign in to see credit history.");
  if ("response" in resolved) return resolved.response;
  const params = new URL(request.url).searchParams;
  const cursor = params.get("cursor");
  try { historyCursor(cursor); } catch {
    return NextResponse.json({ error: "Invalid credit history cursor." }, { status: 400 });
  }
  const page = isDbMode() ? await listCreditHistory(getDb(), resolved.workspace.id, cursor) : demoCreditHistory();
  if (params.get("format") === "csv") return new Response(creditHistoryCsv(page.entries), { headers: {
    "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=credit-history.csv", "cache-control": "private, no-store",
  } });
  return NextResponse.json(page, { headers: { "cache-control": "private, no-store" } });
}
