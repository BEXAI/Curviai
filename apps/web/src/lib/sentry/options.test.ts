import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it, vi } from "vitest";
import { ErrorEventLimiter } from "./limits";
import { createBeforeSend, sentryDsn, sentryInitOptions } from "./options";
import { createScrubber } from "./scrub";

// docs/phases/PHASE_20.md P20-13: Sentry's init options.

const DSN = "https://public@o0.ingest.sentry.io/0";

describe("sentryInitOptions", () => {
  it("is null without a DSN, so nothing is initialized or sent", () => {
    expect(sentryDsn({})).toBeNull();
    expect(sentryDsn({ SENTRY_DSN: "  " })).toBeNull();
    expect(sentryInitOptions({})).toBeNull();
    // The browser DSN alone does not turn on server reporting.
    expect(sentryInitOptions({ NEXT_PUBLIC_SENTRY_DSN: DSN })).toBeNull();
  });

  it("turns the SDK's own collection down, sets the release from the deploy's commit and adds the console capture", () => {
    const options = sentryInitOptions({ SENTRY_DSN: DSN, RENDER_GIT_COMMIT: "0123456789abcdef" });
    expect(options).toMatchObject({ dsn: DSN, release: "0123456789abcdef" });
    // SDK 11 has no sendDefaultPii; dataCollection replaces it and
    // collects everything unless told otherwise.
    expect(options?.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: expect.arrayContaining(["user-agent", "content-type"]) }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
    const allowed = (options?.dataCollection?.httpHeaders as { request: { allow: string[] } }).request.allow;
    expect(allowed.filter((name) => /auth|cookie|secret|token|signature|key/i.test(name))).toEqual([]);
    // Errors only: no tracing.
    expect(options).not.toHaveProperty("tracesSampleRate");
    const integrations = options?.integrations;
    expect(typeof integrations).toBe("function");
    const added = (integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>)([{ name: "Default" }]);
    expect(added.map((integration) => integration.name)).toEqual(["Default", "CaptureConsole"]);
    expect(sentryInitOptions({ SENTRY_DSN: DSN })?.release).toBeUndefined();
  });

  it("scrubs in beforeSend with the env's secrets", () => {
    const options = sentryInitOptions({ SENTRY_DSN: DSN, CRON_SECRET: "cron-secret-value-0123456789" });
    const beforeSend = options?.beforeSend as (event: ErrorEvent) => ErrorEvent | null;
    const out = beforeSend({ type: undefined, message: "header cron-secret-value-0123456789 refused" } as ErrorEvent);
    expect(out?.message).toBe("header [redacted] refused");
  });
});

describe("createBeforeSend", () => {
  function setup(limits = { maxSameErrorPerHour: 2, maxEventsPerHour: 3, maxEventsPerDay: 5 }) {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const log = { warn: vi.fn() };
    const beforeSend = createBeforeSend({
      scrubber: createScrubber({}),
      limiter: new ErrorEventLimiter(limits, () => now),
      now: () => now,
      log,
    });
    return { beforeSend, log, advance: (ms: number) => (now += ms) };
  }

  const error = (message: string): ErrorEvent => ({ type: undefined, message }) as ErrorEvent;

  it("drops repeats past the per error limit and logs the drop once an hour, as a warning", () => {
    const { beforeSend, log, advance } = setup();
    expect(beforeSend(error("same"))).not.toBeNull();
    expect(beforeSend(error("same"))).not.toBeNull();
    expect(beforeSend(error("same"))).toBeNull();
    expect(beforeSend(error("same"))).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.warn.mock.calls[0][0]))).toMatchObject({
      event: "sentry_event_dropped",
      limit: "same_error_limit",
    });
    advance(30 * 60_000);
    expect(beforeSend(error("same"))).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("drops anything past the hourly cap", () => {
    const { beforeSend } = setup();
    expect(["a", "b", "c", "d"].map((m) => beforeSend(error(m)) !== null)).toEqual([true, true, true, false]);
  });

  it("drops an event whose scrub fails instead of sending it unscrubbed", () => {
    const beforeSend = createBeforeSend({
      scrubber: {
        scrubText: (text) => text,
        scrubEvent: () => {
          throw new Error("bad event");
        },
      },
      limiter: new ErrorEventLimiter({ maxSameErrorPerHour: 9, maxEventsPerHour: 9, maxEventsPerDay: 9 }),
      log: { warn: vi.fn() },
    });
    expect(beforeSend(error("x"))).toBeNull();
  });
});
