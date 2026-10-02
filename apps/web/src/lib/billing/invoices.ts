import type Stripe from "stripe";
import { canManageBilling } from "./access";
import type { WorkspaceRole } from "@/lib/services/types";
import { STRIPE_LOOKUP_OPTIONS } from "./stripe";
import { billingViews } from "@curvi/pipeline/seed";

export interface InvoiceView { id: string; number: string | null; date: string; total: number; currency: string; status: string; url: string | null; pdf: string | null }
export function invoiceView(invoice: Stripe.Invoice): InvoiceView {
  if (!invoice.id) throw new Error("An invoice is missing its identifier.");
  return { id: invoice.id, number: invoice.number, date: new Date(invoice.created * 1000).toISOString(),
    total: invoice.total / 100, currency: invoice.currency, status: invoice.status ?? "draft",
    url: invoice.hosted_invoice_url ?? null, pdf: invoice.invoice_pdf ?? null };
}
const cache = new Map<string, { at: number; rows: InvoiceView[] }>();
/** Role and customer are resolved on the server before the cache is consulted. */
export async function listInvoices(stripe: Stripe, customerId: string | null, role: WorkspaceRole, now = Date.now()): Promise<InvoiceView[]> {
  if (!canManageBilling(role)) throw new Error("Only the workspace owner or an admin can view invoices.");
  if (!customerId) return [];
  const hit = cache.get(customerId);
  if (hit && now - hit.at < billingViews.invoiceCacheMinutes * 60_000) return hit.rows;
  const response = await stripe.invoices.list({ customer: customerId, limit: billingViews.invoicePageSize }, STRIPE_LOOKUP_OPTIONS);
  const rows = response.data.map(invoiceView);
  if (cache.size >= billingViews.invoiceCacheCustomers) cache.clear();
  cache.set(customerId, { at: now, rows });
  return rows;
}
