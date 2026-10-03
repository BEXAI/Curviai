"use client";
import { useState } from "react";
import type { CreditPlanningView } from "@/lib/billing/credit-planning";
import { creditPlanningPolicy } from "@curvi/pipeline/seed";

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const creditAmount = (value: number) => value < 0 ? `${number(-value)} credits below zero` : `${number(value)} credits`;
const date = (value: string) => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

export function CreditPlanning({ initial, canChange, demo = false }: { initial: CreditPlanningView; canChange: boolean; demo?: boolean }) {
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.budget.monthlyLimit !== null);
  const [limit, setLimit] = useState(initial.budget.monthlyLimit === null ? "" : String(initial.budget.monthlyLimit));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/billing/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyLimit: enabled ? Number(limit) : null }) });
      const result = await response.json() as { error?: string; budget?: CreditPlanningView["budget"] };
      if (!response.ok || !result.budget) throw new Error(result.error ?? "The budget could not be saved.");
      setView((current) => ({ ...current, budget: result.budget! }));
      setNotice(enabled ? "Credit budget saved. Existing reservations can still finish." : "Credit budget disabled. Your balance and plan still apply.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The budget could not be saved."); }
    finally { setSaving(false); }
  }
  return <section id="credit-planning" className="space-y-4" aria-labelledby="credit-planning-title">
    <div><h2 id="credit-planning-title" className="text-lg font-semibold text-ink-950">Credit planning</h2>
      <p className="mt-1 text-sm text-ink-600">{demo ? "Demo figures. " : ""}Calendar month from {date(view.budget.periodStart)} until {date(view.budget.periodEnd)}, midnight UTC.</p></div>
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[["Available now", view.available], ["Active holds, all months", view.budget.held], ["Delivered this month", view.budget.consumed], [`Returned in the last ${creditPlanningPolicy.observationDays} days`, view.observation.returned]].map(([label, value]) => <div key={label} className="rounded-xl border border-ink-100 p-4"><dt className="text-sm text-ink-600">{label}</dt><dd className="mt-1 text-xl font-semibold"><a href="#credit-history">{creditAmount(Number(value))}</a></dd></div>)}
    </dl>
    <p className="text-sm text-ink-600">Delivered work is counted once when charged. Active holds reserve credits until work settles. Returned credits exclude the release that converts a hold into a charge. Grants and billing corrections change your balance, not your delivered usage.</p>
    <p className="text-sm text-ink-700" data-testid="credit-projection">{view.projection.monthTotal === null ? "Insufficient history for a consumption estimate." : `Estimated delivered usage by month end: about ${number(view.projection.monthTotal)} credits.`} Based on up to {creditPlanningPolicy.observationDays} days of charged work. Sparse or irregular product work can make this estimate unreliable. It does not schedule work or buy credits.</p>
    <p className="text-xs text-ink-500">Observation from {date(view.observation.from)} to {date(view.observation.to)} in UTC. <a className="underline" href="#credit-history">{number(view.observation.consumed)} credits charged during this window</a>.</p>
    <div className="rounded-xl border border-ink-100 p-4">
      <h3 className="font-semibold text-ink-900">Optional monthly credit budget</h3>
      <p className="mt-1 text-sm text-ink-600">{view.budget.monthlyLimit === null ? "Disabled. Your available balance and plan still apply." : `Limit ${number(view.budget.monthlyLimit)} credits. Remaining headroom ${number(Math.max(0, view.budget.remaining ?? 0))} credits after delivered work and every active hold.`}</p>
      <p className="mt-2 text-sm text-ink-600">The budget resets at the start of each UTC calendar month. Holds from earlier months still count until settled. Lowering the limit blocks new work without canceling existing reservations. A zero limit pauses new work. Credits keep their existing terms.</p>
      {canChange && !demo ? <form onSubmit={save} className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={saving} />Use a monthly credit budget</label>
        <label className="block text-sm" htmlFor="monthly-credit-limit">Monthly limit in credits</label>
        <input id="monthly-credit-limit" type="number" min="0" max={creditPlanningPolicy.maxMonthlyCredits} step={creditPlanningPolicy.creditStep} required={enabled} disabled={!enabled || saving} value={limit} onChange={(event) => setLimit(event.target.value)} aria-describedby="credit-budget-status credit-budget-error" className="rounded-lg border border-ink-200 px-3 py-2" />
        <div><button type="submit" disabled={saving} className="rounded-lg bg-ink-950 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? "Saving budget" : "Save credit budget"}</button></div>
      </form> : <p className="mt-3 text-sm text-ink-600">{demo ? "Budget changes are unavailable in the demo." : "Only the workspace owner can change this budget."}</p>}
      <p id="credit-budget-status" role="status" className="mt-2 text-sm text-ink-700">{notice}</p>
      <p id="credit-budget-error" role="alert" className="mt-2 text-sm text-red-700">{error}</p>
    </div>
  </section>;
}
