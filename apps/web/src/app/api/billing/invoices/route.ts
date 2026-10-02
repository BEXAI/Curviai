import { NextResponse } from "next/server";
import { resolveSignedIn } from "@/lib/http/services";
import { isDbMode } from "@/lib/services";
import { canManageBilling, BILLING_FORBIDDEN_NOTICE } from "@/lib/billing/access";
import { loadBillingAccount } from "@/lib/billing/account";
import { listInvoices } from "@/lib/billing/invoices";
import { hasStripeApiKey } from "@/lib/env";
import { getStripe } from "@/lib/billing/stripe";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  const resolved = await resolveSignedIn("Sign in to see invoices.");
  if ("response" in resolved) return resolved.response;
  if (!canManageBilling(resolved.workspace.role)) return NextResponse.json({ error: BILLING_FORBIDDEN_NOTICE }, { status: 403 });
  const account = await loadBillingAccount(resolved.workspace.id);
  try {
    const invoices = isDbMode() && hasStripeApiKey() ? await listInvoices(getStripe(), account.stripeCustomerId, resolved.workspace.role) : [];
    return NextResponse.json({ invoices }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "We could not load invoices. Try again in a minute." }, { status: 502 });
  }
}
