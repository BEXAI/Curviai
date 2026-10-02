"use client";

import { useState } from "react";
import { Button } from "@curvi/ui";
import { CLAIM_COPY } from "@/lib/prospects/copy";

type Step = "idle" | "confirm" | "busy" | "done" | "failed";

/**
 * "Not yours, or want this page removed? Take it down here" (P18-04): asks
 * once, then posts to /api/claims/{token}/takedown, which makes the page
 * private for everyone.
 */
export function ProspectTakedown({ token }: { token: string }) {
  const [step, setStep] = useState<Step>("idle");

  async function takeDown() {
    setStep("busy");
    try {
      const response = await fetch(`/api/claims/${encodeURIComponent(token)}/takedown`, { method: "POST" });
      setStep(response.ok ? "done" : "failed");
    } catch {
      setStep("failed");
    }
  }

  if (step === "done") {
    return (
      <p role="status" data-testid="prospect-takedown-done">
        {CLAIM_COPY.done}
      </p>
    );
  }
  if (step === "failed") {
    return <p role="alert">{CLAIM_COPY.failed}</p>;
  }
  if (step === "confirm" || step === "busy") {
    return (
      <div className="space-y-3">
        <p>{CLAIM_COPY.confirm}</p>
        <div className="flex justify-center gap-3">
          <Button variant="danger" size="sm" disabled={step === "busy"} onClick={() => void takeDown()} data-testid="prospect-takedown-confirm">
            {CLAIM_COPY.confirmButton}
          </Button>
          <Button variant="ghost" size="sm" disabled={step === "busy"} onClick={() => setStep("idle")}>
            {CLAIM_COPY.cancel}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <p>
      {CLAIM_COPY.footerQuestion}{" "}
      <button
        type="button"
        className="font-medium text-ink-900 underline"
        onClick={() => setStep("confirm")}
        data-testid="prospect-takedown"
      >
        {CLAIM_COPY.takedownLink}
      </button>
      , {CLAIM_COPY.footerEmail}
    </p>
  );
}
