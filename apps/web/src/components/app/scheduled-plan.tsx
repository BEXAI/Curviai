"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@curvi/ui";
import type { BillingCadence, PaidTierKey } from "@/lib/billing/plans";

export function ScheduledPlanButton({ label, target }: { label: string; target?: { tier: PaidTierKey; cadence: BillingCadence } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function change() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/billing/schedule", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target ? { action: "schedule", ...target } : { action: "keep" }),
      });
      const data = await response.json() as { ok?: boolean; notice?: string };
      setNotice(data.notice ?? "The change could not be saved.");
      if (data.ok) router.refresh();
    } catch {
      setNotice("The change could not be saved. Refresh Billing before trying again.");
    } finally { setBusy(false); }
  }
  return <div data-testid={target ? `schedule-plan-${target.tier}` : "keep-current-plan"}>
    <Button variant="outline" disabled={busy} onClick={() => void change()}>{busy ? "Saving" : label}</Button>
    {target ? <p className="mt-2 text-xs text-ink-500">Starts at your next renewal. Your current plan and credits stay available until then.</p> : null}
    {notice ? <p role="status" className="mt-2 text-sm text-ink-600">{notice}</p> : null}
  </div>;
}
