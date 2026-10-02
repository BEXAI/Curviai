"use client";

import { useState } from "react";
import { PackFeedbackForm } from "@/components/app/pack-feedback-form";

/**
 * The pack feedback questions on the signed link page (P18-05): posts to
 * /api/feedback/{token}, then shows the thank you line in place of the form.
 */
export function FeedbackLinkForm({ token }: { token: string }) {
  const [thanks, setThanks] = useState<string | null>(null);
  if (thanks) {
    return (
      <p className="mt-6 text-ink-700" role="status" data-testid="feedback-thanks">
        {thanks}
      </p>
    );
  }
  return (
    <div className="mt-6 rounded-xl border border-ink-100 bg-white p-5">
      <PackFeedbackForm
        endpoint={`/api/feedback/${encodeURIComponent(token)}`}
        idPrefix="feedback-link"
        onDone={(_status, notice) => setThanks(notice)}
      />
    </div>
  );
}
