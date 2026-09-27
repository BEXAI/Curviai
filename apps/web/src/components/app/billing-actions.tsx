"use client";

import { useState } from "react";
import { Button } from "@curvi/ui";

type CheckoutBody =
  | { kind: "tier"; tier: string; cadence: "monthly" | "annual" }
  | { kind: "topup"; credits: number };

async function requestUrl(path: string, body?: CheckoutBody): Promise<{ url?: string; notice?: string; error?: string }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  return (await response.json()) as { url?: string; notice?: string; error?: string };
}

export function CheckoutButton({
  label,
  body,
  variant = "primary",
}: {
  label: string;
  body: CheckoutBody;
  variant?: "primary" | "secondary" | "outline";
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setNotice(null);
    try {
      const data = await requestUrl("/api/billing/checkout", body);
      if (data.url) {
        window.location.assign(data.url);
        return;
      }
      setNotice(data.notice ?? data.error ?? "Checkout is not available right now.");
    } catch {
      setNotice("Checkout is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant={variant} className="w-full" disabled={busy} onClick={() => void go()}>
        {busy ? "Opening" : label}
      </Button>
      {notice ? (
        <p className="mt-2 text-xs text-amber-700" data-testid="billing-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function PortalButton() {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setNotice(null);
    try {
      const data = await requestUrl("/api/billing/portal");
      if (data.url) {
        window.location.assign(data.url);
        return;
      }
      setNotice(data.notice ?? data.error ?? "The portal is not available right now.");
    } catch {
      setNotice("The portal is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="outline" disabled={busy} onClick={() => void go()}>
        {busy ? "Opening" : "Open customer portal"}
      </Button>
      {notice ? <p className="mt-2 text-xs text-amber-700">{notice}</p> : null}
    </div>
  );
}
