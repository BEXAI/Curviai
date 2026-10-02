import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/phases/PHASE_20.md P20-13: no DSN means no Sentry at all; with one,
// the server config initializes Sentry and installs the founder alert hook.

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureRequestError: vi.fn(), captureConsoleIntegration: vi.fn() }));
const alertHook = vi.hoisted(() => ({ setAlertReport: vi.fn() }));

vi.mock("@sentry/nextjs", () => sentry);
vi.mock("@curvi/trigger/alert-report", () => alertHook);

beforeEach(() => {
  vi.resetModules();
  sentry.init.mockReset();
  alertHook.setAlertReport.mockReset();
  vi.stubEnv("SENTRY_DSN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentry.server.config", () => {
  it("does nothing without SENTRY_DSN", async () => {
    await import("./sentry.server.config");
    expect(sentry.init).not.toHaveBeenCalled();
    expect(alertHook.setAlertReport).not.toHaveBeenCalled();
  });

  it("initializes Sentry and installs the founder alert hook with a DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/0");
    vi.stubEnv("RENDER_GIT_COMMIT", "abc1234def");
    await import("./sentry.server.config");
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init.mock.calls[0][0]).toMatchObject({ release: "abc1234def", dataCollection: { userInfo: false, cookies: false } });
    expect(alertHook.setAlertReport).toHaveBeenCalledTimes(1);
    expect(typeof alertHook.setAlertReport.mock.calls[0][0]).toBe("function");
  });
});

describe("sentry.edge.config", () => {
  it("does nothing without SENTRY_DSN and initializes with one", async () => {
    await import("./sentry.edge.config");
    expect(sentry.init).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/0");
    await import("./sentry.edge.config");
    expect(sentry.init).toHaveBeenCalledTimes(1);
  });
});

describe("instrumentation", () => {
  it("hands request errors to Sentry and loads the config of its runtime", async () => {
    const instrumentation = await import("./instrumentation");
    expect(instrumentation.onRequestError).toBe(sentry.captureRequestError);

    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/0");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await instrumentation.register();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(alertHook.setAlertReport).toHaveBeenCalledTimes(1);
  });
});
