"use client";

/** Friendly failure screen for the app shell, replacing the blank crash page. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold text-ink-950">Something went wrong on our side</h1>
      <p className="mt-3 text-ink-600">
        We could not load your workspace just now. Try again in a moment. If it keeps happening,
        email hello@curvi.ai and we will look right away.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white transition-colors hover:bg-ink-800"
      >
        Try again
      </button>
    </div>
  );
}
