"use client";

import { useEffect, useState } from "react";
import type { HistoryPage } from "@/lib/billing/history";
import type { InvoiceView } from "@/lib/billing/invoices";

export function BillingHistory({ canViewInvoices }: { canViewInvoices: boolean }) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    void fetch(`/api/billing/history${query}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      setPage(await response.json() as HistoryPage);
    }).catch(() => { if (!controller.signal.aborted) setError("We could not load credit history. Try again in a minute."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cursor]);
  useEffect(() => {
    if (!canViewInvoices) return;
    const controller = new AbortController();
    void fetch("/api/billing/invoices", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { invoices: InvoiceView[] };
      setInvoices(data.invoices);
    }).catch(() => { if (!controller.signal.aborted) setInvoiceError(true); });
    return () => controller.abort();
  }, [canViewInvoices]);
  const csvHref = `/api/billing/history?format=csv${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  return <>
    <section aria-labelledby="credit-history-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="credit-history-title" className="text-lg font-semibold text-ink-950">Credit history</h2>
        <a href={csvHref} className="text-sm text-accent-700 underline">Download this page as CSV</a>
      </div>
      {loading ? <p role="status">Loading credit history.</p> : error ? <p role="alert">{error}</p> : page?.entries.length ? <>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr><th className="p-2">Date</th><th className="p-2">Description</th><th className="p-2 text-right">Credits</th></tr></thead>
          <tbody>{page.entries.map((entry) => <tr key={entry.id} className="border-t border-ink-100">
            <td className="p-2 whitespace-nowrap">{entry.at.slice(0, 10)}</td>
            <td className="p-2">{entry.jobId ? <a href={`/app/jobs/${entry.jobId}`} className="underline">{entry.label}</a> : entry.label}
              {entry.held ? <p className="text-xs text-ink-600">Held while the pack runs</p> : null}</td>
            <td className="p-2 text-right tabular-nums">{entry.credits > 0 ? "+" : ""}{entry.credits}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex gap-4 text-sm">
          {cursor ? <button className="underline" onClick={() => setCursor(null)}>Latest entries</button> : null}
          {page.nextCursor ? <button className="underline" onClick={() => setCursor(page.nextCursor)}>Older entries</button> : null}
        </div>
      </> : <p className="text-sm text-ink-600">Your credit activity will appear here.</p>}
    </section>
    {canViewInvoices ? <section aria-labelledby="invoices-title" className="space-y-3">
      <h2 id="invoices-title" className="text-lg font-semibold text-ink-950">Invoices</h2>
      {invoiceError ? <p role="status">We could not load invoices. You can also find them in the billing portal.</p> : invoices.length ? <ul className="space-y-3 text-sm">{invoices.map((invoice) => <li key={invoice.id} className="flex flex-wrap gap-3">
        <span>{invoice.date.slice(0, 10)} · {invoice.number ?? "Invoice"} · {new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency }).format(invoice.total)} · {invoice.status}</span>
        {invoice.url ? <a href={invoice.url} target="_blank" rel="noopener noreferrer" className="underline">View</a> : null}
        {invoice.pdf ? <a href={invoice.pdf} target="_blank" rel="noopener noreferrer" className="underline">PDF</a> : null}
      </li>)}</ul> : <p className="text-sm text-ink-600">Invoices appear here after a plan payment.</p>}
    </section> : null}
  </>;
}
