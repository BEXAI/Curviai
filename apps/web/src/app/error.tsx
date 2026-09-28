"use client";

/** Site wide failure screen so no route ever renders a blank error page. */
export default function SiteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold text-ink-950">Something went wrong</h1>
      <p className="mt-3 text-ink-600">
        Try again in a moment, or head back to the homepage. If it keeps happening, email
        hello@curvi.ai.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white transition-colors hover:bg-ink-800"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-lg border border-ink-950/15 bg-white px-4 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50"
        >
          Go home
        </a>
      </div>
    </div>
  );
}
