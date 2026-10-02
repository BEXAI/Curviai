"use client";

import { useState } from "react";
import { Button } from "@curvi/ui";
import { UNSUBSCRIBE_BUSY, UNSUBSCRIBE_BUTTON, UNSUBSCRIBE_DONE, UNSUBSCRIBE_FAILED } from "@/lib/email/copy";

/** The one confirm button on /email/unsubscribe (P18-06). */
export function UnsubscribeForm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("busy");
    try {
      const response = await fetch("/api/email/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "done") {
    return (
      <p className="mt-6 font-medium text-ink-950" role="status" data-testid="unsubscribe-done">
        {UNSUBSCRIBE_DONE}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="mt-6">
      <Button type="submit" disabled={state === "busy"}>
        {state === "busy" ? UNSUBSCRIBE_BUSY : UNSUBSCRIBE_BUTTON}
      </Button>
      {state === "failed" ? (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {UNSUBSCRIBE_FAILED}
        </p>
      ) : null}
    </form>
  );
}
