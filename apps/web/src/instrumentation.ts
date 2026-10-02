/**
 * Next.js instrumentation (docs/phases/PHASE_20.md P20-13), in the shape
 * Sentry documents for Next.js 15 (checked 2026-10-01, docs/verification.md):
 * register() loads the Sentry config of the runtime it runs in, and
 * onRequestError hands every server request error (route handlers, server
 * components, server actions, middleware) to Sentry with its route.
 * Without SENTRY_DSN neither config calls init, and captureRequestError
 * does nothing.
 */

import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    const { startJobRecovery } = await import("./lib/jobs/recovery");
    startJobRecovery();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
