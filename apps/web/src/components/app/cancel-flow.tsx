"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, Label, Textarea, cn } from "@curvi/ui";
import {
  MAX_CANCEL_DETAIL,
  offersForReason,
  type CancelChoice,
  type CancelReason,
  type SaveOffer,
} from "@/lib/billing/cancel-flow";
import { track } from "@/lib/track";

interface CancelOptionsResponse {
  tier: string;
  reasons: ReadonlyArray<{ key: CancelReason; label: string }>;
  offers: SaveOffer[];
  live: boolean;
  periodEnd: string | null;
  error?: string;
  notice?: string;
}

interface CancelChoiceResponse {
  ok?: boolean;
  outcome?: string;
  notice?: string;
  error?: string;
}

type Step =
  | { name: "idle" }
  | { name: "reason"; options: CancelOptionsResponse }
  | { name: "offers"; options: CancelOptionsResponse }
  | { name: "confirm"; options: CancelOptionsResponse }
  | { name: "done"; notice: string };

function formatDate(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * The cancel flow on /app/billing: Cancel plan, then a reason, then the save
 * offers that fit it (pause, a smaller plan, a discount), then a final
 * confirmation. Every exit that follows a reason is recorded, including
 * keeping the plan. The server decides which offers apply and whether the
 * choice reaches Stripe.
 */
export function CancelFlow({ planName }: { planName: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const baseId = useId();

  async function open() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/billing/cancel", { cache: "no-store" });
      const data = (await response.json()) as CancelOptionsResponse;
      if (!response.ok) {
        setNotice(data.notice ?? "The cancel options could not be loaded. Try again in a minute.");
        return;
      }
      track("cancel_flow_opened", { tier: data.tier });
      setStep({ name: "reason", options: data });
    } catch {
      setNotice("The cancel options could not be loaded. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  async function choose(choice: CancelChoice) {
    if (!reason) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, detail: detail.trim() || null, choice }),
      });
      const data = (await response.json()) as CancelChoiceResponse;
      if (!response.ok || !data.ok) {
        setNotice(data.notice ?? "That did not go through. Nothing changed. Try again in a minute.");
        return;
      }
      track("cancel_flow_finished", { reason, choice, outcome: data.outcome ?? null });
      setStep({ name: "done", notice: data.notice ?? "Saved." });
      if (choice !== "keep") {
        router.refresh();
      }
    } catch {
      setNotice("That did not go through. Nothing changed. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setStep({ name: "idle" });
    setReason(null);
    setDetail("");
    setNotice(null);
  }

  if (step.name === "idle") {
    return (
      <div>
        <Button variant="outline" disabled={busy} onClick={() => void open()} data-testid="cancel-open">
          {busy ? "Opening" : "Cancel plan"}
        </Button>
        {notice ? (
          <p className="mt-2 text-sm text-amber-700" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    );
  }

  if (step.name === "done") {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" role="status" data-testid="cancel-result">
        {step.notice}
      </p>
    );
  }

  const { options } = step;
  const periodEnd = formatDate(options.periodEnd);

  return (
    <Card data-testid="cancel-flow">
      <CardContent className="space-y-5 p-5">
        {step.name === "reason" ? (
          <fieldset>
            <legend className="text-base font-semibold text-ink-950">Why do you want to cancel?</legend>
            <p className="mt-1 text-sm text-ink-500">Your answer helps us fix what is not working.</p>
            <div className="mt-3 space-y-2">
              {options.reasons.map((r) => (
                <label
                  key={r.key}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                    reason === r.key ? "border-ink-900 bg-ink-50" : "border-ink-200",
                  )}
                >
                  <input
                    type="radio"
                    name={`${baseId}-reason`}
                    value={r.key}
                    checked={reason === r.key}
                    onChange={() => setReason(r.key)}
                    data-testid={`cancel-reason-${r.key}`}
                  />
                  {r.label}
                </label>
              ))}
            </div>
            <div className="mt-4">
              <Label htmlFor={`${baseId}-detail`}>Anything else we should know? This is optional.</Label>
              <Textarea
                id={`${baseId}-detail`}
                className="mt-1"
                maxLength={MAX_CANCEL_DETAIL}
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                disabled={!reason}
                onClick={() =>
                  setStep(options.offers.length > 0 ? { name: "offers", options } : { name: "confirm", options })
                }
                data-testid="cancel-continue"
              >
                Continue
              </Button>
              <Button variant="ghost" onClick={close}>
                Never mind
              </Button>
            </div>
          </fieldset>
        ) : null}

        {step.name === "offers" && reason ? (
          <div>
            <h3 className="text-base font-semibold text-ink-950">Before you go</h3>
            <p className="mt-1 text-sm text-ink-500">One of these might fit better than canceling.</p>
            <ul className="mt-3 grid gap-3 md:grid-cols-3">
              {offersForReason(options.offers, reason).map((offer) => (
                <li key={offer.kind} className="flex flex-col rounded-xl border border-ink-200 p-4" data-testid={`cancel-offer-${offer.kind}`}>
                  <p className="font-medium text-ink-900">{offer.title}</p>
                  <p className="mt-1 flex-1 text-sm text-ink-600">{offer.body}</p>
                  <Button className="mt-3" variant="secondary" disabled={busy} onClick={() => void choose(offer.kind)}>
                    {offer.action}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="primary" disabled={busy} onClick={() => void choose("keep")} data-testid="cancel-keep">
                Keep my plan
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setStep({ name: "confirm", options })} data-testid="cancel-no-thanks">
                No thanks, continue to cancel
              </Button>
            </div>
          </div>
        ) : null}

        {step.name === "confirm" ? (
          <div>
            <h3 className="text-base font-semibold text-ink-950">Cancel your {planName} plan?</h3>
            <p className="mt-1 text-sm text-ink-600">
              {periodEnd
                ? `Your plan stays active until ${periodEnd}. After that your workspace moves to the Free plan.`
                : "Your plan stays active until the end of the period you paid for. After that your workspace moves to the Free plan."}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="danger" disabled={busy} onClick={() => void choose("cancel")} data-testid="cancel-confirm">
                {busy ? "Canceling" : "Cancel my plan"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void choose("keep")}>
                Keep my plan
              </Button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p className="text-sm text-amber-700" role="status">
            {notice}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
