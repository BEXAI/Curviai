import * as Sentry from "@sentry/nextjs";
import { errorReporting } from "@curvi/pipeline/seed";
import { createScrubber } from "./scrub";
import { ErrorEventLimiter, eventFingerprint } from "./limits";

let initialized = false;
export function initializeBrowserErrors() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn || initialized) return;
  initialized = true;
  const scrubber = createScrubber({});
  const limiter = new ErrorEventLimiter(errorReporting);
  Sentry.init({
    dsn, tunnel: "/monitoring", tracesSampleRate: 0,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false },
    integrations: (defaults) => defaults.filter((entry) => !/replay|tracing|feedback|console/i.test(entry.name)),
    beforeSend(event) {
      if (limiter.check(eventFingerprint(event)) !== "send") return null;
      try { return scrubber.scrubEvent(event); } catch { return null; }
    },
  });
}
export function reportBrowserError(error: Error & { digest?: string }) {
  initializeBrowserErrors();
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) Sentry.captureException(error, { tags: { digest: error.digest } });
}
