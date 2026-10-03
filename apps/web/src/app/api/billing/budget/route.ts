import { NextResponse } from "next/server";
import { resolveSignedIn } from "@/lib/http/services";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { getSessionUser } from "@/lib/supabase/server";
import { CreditBudgetInput, CREDIT_BUDGET_OWNER_MESSAGE } from "@/lib/billing/credit-budget";
import { readCreditBudget, setCreditBudget, demoCreditPlanning } from "@/lib/billing/credit-planning";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
/** Generating members may see the limit that applies to their estimate. */
export async function GET(): Promise<Response> {
  const resolved = await resolveSignedIn("Sign in to see the credit budget.");
  if ("response" in resolved) return resolved.response;
  if (resolved.workspace.role === "client") return NextResponse.json({ error: "A client seat cannot plan new packs." }, { status: 403 });
  const budget = isDbMode() ? await readCreditBudget(getDb(), resolved.workspace.id) : demoCreditPlanning(resolved.workspace.creditBalance).budget;
  return NextResponse.json({ budget }, { headers });
}
export async function POST(request: Request): Promise<Response> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) return crossSite;
  const resolved = await resolveSignedIn("Sign in to change the credit budget.");
  if ("response" in resolved) return resolved.response;
  if (resolved.workspace.role !== "owner") return NextResponse.json({ error: CREDIT_BUDGET_OWNER_MESSAGE }, { status: 403 });
  const body = await readJsonCapped(request);
  if (!body.ok) return body.response;
  const parsed = CreditBudgetInput.safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Enter a credit limit of zero or more with at most one decimal place, or disable the budget." }, { status: 400 });
  if (!isDbMode()) return NextResponse.json({ error: "Budget changes are unavailable in the demo." }, { status: 503 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to change the credit budget." }, { status: 401 });
  try {
    await setCreditBudget(getDb(), resolved.workspace.id, user.id, parsed.data.monthlyLimit);
    return NextResponse.json({ ok: true, budget: await readCreditBudget(getDb(), resolved.workspace.id) }, { headers });
  } catch {
    return NextResponse.json({ error: "The budget could not be saved. Refresh Billing before trying again." }, { status: 409, headers });
  }
}
