/**
 * Sentry for the edge runtime, which runs only the middleware today
 * (docs/phases/PHASE_20.md P20-13). Same options and scrubbing as the
 * server (lib/sentry/options.ts); nothing happens without SENTRY_DSN.
 */

import * as Sentry from "@sentry/nextjs";
import { sentryInitOptions } from "@/lib/sentry/options";

const options = sentryInitOptions(process.env);
if (options) {
  Sentry.init(options);
}
