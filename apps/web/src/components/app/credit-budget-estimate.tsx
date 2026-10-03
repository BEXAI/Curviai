"use client";
import { useEffect, useState } from "react";
import type { CreditBudgetView } from "@/lib/billing/credit-planning";
import { creditBudgetEstimateLine } from "@/lib/billing/credit-budget";

export function CreditBudgetEstimate({ creditsNeeded }: { creditsNeeded: number }) {
  const [budget, setBudget] = useState<CreditBudgetView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/billing/budget", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { budget: CreditBudgetView };
      setBudget(data.budget);
    }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, []);
  const line = budget ? creditBudgetEstimateLine(budget, creditsNeeded) : null;
  return line || unavailable ? <p className="mt-1 text-xs text-ink-600" data-testid="credit-budget-estimate">
    {line ?? "Budget headroom is unavailable. The current owner budget will be checked before this pack starts."}
    {line ? " Checked again when the pack starts." : ""}
  </p> : null;
}
