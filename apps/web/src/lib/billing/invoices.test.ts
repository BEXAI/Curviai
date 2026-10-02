import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { invoiceView, listInvoices } from "./invoices";
describe("invoices", () => {
  it("maps Stripe invoice links and amount without inventing draft links", () => {
    expect(invoiceView({ id: "in_1", number: "100", created: 0, total: 2900, currency: "usd", status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/x", invoice_pdf: null } as Stripe.Invoice))
      .toMatchObject({ total: 29, url: "https://invoice.stripe.com/i/x", pdf: null });
  });
  it("denies editors before Stripe or a cached result and caches owners for five minutes", async () => {
    const list = vi.fn(async () => ({ data: [] }));
    const stripe = { invoices: { list } } as unknown as Stripe;
    await listInvoices(stripe, "cus_history_test", "owner", 1000);
    await listInvoices(stripe, "cus_history_test", "admin", 2000);
    await expect(listInvoices(stripe, "cus_history_test", "editor", 3000)).rejects.toThrow("owner or an admin");
    await expect(listInvoices(stripe, "cus_history_test", "client", 3000)).rejects.toThrow("owner or an admin");
    expect(list).toHaveBeenCalledTimes(1);
    await listInvoices(stripe, "cus_history_test", "owner", 302000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
