"use client";
import { useEffect } from "react";

export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) void import("@/lib/sentry/browser").then((m) => m.reportBrowserError(error)).catch(() => {});
  }, [error]);
  return <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
    <h1 className="text-2xl font-bold text-ink-950">Something went wrong on our side</h1>
    <p className="mt-3 text-ink-600">Try again, or <a href="/support" className="underline">contact us at hello@curvi.ai</a> if it keeps happening.</p>
    {error.digest ? <p className="mt-3 break-all text-sm text-ink-700">Reference: <code>{error.digest}</code></p> : null}
    <div className="mt-6 flex gap-4"><button type="button" onClick={reset} className="rounded-lg bg-ink-900 px-4 py-2 text-white">Try again</button><a href="/" className="px-4 py-2 underline">Go home</a></div>
  </div>;
}
