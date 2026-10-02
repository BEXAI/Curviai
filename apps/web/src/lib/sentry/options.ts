/**
 * Sentry's init options for the server and edge runtimes
 * (docs/phases/PHASE_20.md P20-13; the setup verified on 2026-10-01 is in
 * docs/verification.md, PHASE_20).
 *
 * - No DSN, no Sentry: without SENTRY_DSN this returns null, the config
 *   files never call init, and every capture call is a no op.
 * - What the SDK collects by itself is turned down with dataCollection.
 *   SDK 11 removed sendDefaultPii (the plan's setting) and collects user
 *   identity, cookies, headers, bodies, query strings and stack frame local
 *   variables by default (Sentry's options page, checked 2026-10-01,
 *   docs/verification.md). Here: no user info, cookies, bodies, query
 *   strings, database or queue data, AI inputs or outputs, or local
 *   variables, and only the request headers lib/sentry/scrub.ts keeps.
 * - The release is the deploy's commit (RENDER_GIT_COMMIT), the name the
 *   build uploads source maps under.
 * - captureConsoleIntegration({ levels: ["error"] }) turns the existing
 *   console.error calls into events with no rewrite. Warnings stay in the
 *   log only.
 * - beforeSend applies the repeat limit and the hourly and daily caps
 *   (lib/sentry/limits.ts), then scrubs every event it lets through
 *   (lib/sentry/scrub.ts). A scrub that throws drops the event: nothing
 *   leaves unscrubbed.
 * - Errors only: no tracing sample rate is set, so no spans are sent.
 */

import * as Sentry from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";
import { errorReporting } from "@curvi/pipeline/seed";
import { ErrorEventLimiter, eventFingerprint, type LimitVerdict } from "./limits";
import { KEPT_REQUEST_HEADERS, createScrubber, type Scrubber } from "./scrub";

export type SentryEnv = Record<string, string | undefined>;
export type SentryInitOptions = Sentry.NodeOptions;

/** The SDK's own collection, turned down to what a report needs. */
export const DATA_COLLECTION: NonNullable<SentryInitOptions["dataCollection"]> = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: [...KEPT_REQUEST_HEADERS] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
};

/** The DSN the server and edge runtimes report to, or null. */
export function sentryDsn(env: SentryEnv): string | null {
  const dsn = env.SENTRY_DSN?.trim();
  return dsn ? dsn : null;
}

/** How often a drop by one limit is logged at most. */
const DROP_LOG_EVERY_MS = 60 * 60_000;

export interface BeforeSendDeps {
  scrubber: Scrubber;
  limiter: Pick<ErrorEventLimiter, "check" | "droppedCounts">;
  now?: () => number;
  log?: Pick<Console, "warn">;
}

/**
 * Count first, then scrub: a hot loop of errors past a cap costs one
 * fingerprint each, and only events that will be sent are scrubbed. The
 * raw event's fingerprint stays in this process's memory and is never
 * sent. A scrub that throws drops the event: nothing leaves unscrubbed.
 */
export function createBeforeSend(deps: BeforeSendDeps): (event: ErrorEvent) => ErrorEvent | null {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const loggedAt = new Map<LimitVerdict, number>();
  return (event) => {
    const verdict = deps.limiter.check(eventFingerprint(event));
    if (verdict === "send") {
      try {
        return deps.scrubber.scrubEvent(event);
      } catch {
        return null;
      }
    }
    const last = loggedAt.get(verdict);
    if (last === undefined || now() - last >= DROP_LOG_EVERY_MS) {
      loggedAt.set(verdict, now());
      // A warning, never console.error: the console capture would send it.
      log.warn(
        JSON.stringify({ level: "warn", event: "sentry_event_dropped", limit: verdict, dropped: deps.limiter.droppedCounts() }),
      );
    }
    return null;
  };
}

/** The init options, the same for the server and edge runtimes, or null
 * without a DSN. */
export function sentryInitOptions(env: SentryEnv): SentryInitOptions | null {
  const dsn = sentryDsn(env);
  if (!dsn) {
    return null;
  }
  return {
    dsn,
    release: env.RENDER_GIT_COMMIT?.trim() || undefined,
    dataCollection: DATA_COLLECTION,
    integrations: (defaults) => [...defaults, Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: createBeforeSend({ scrubber: createScrubber(env), limiter: new ErrorEventLimiter(errorReporting) }),
  };
}
