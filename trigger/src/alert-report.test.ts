import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAlertReport, reportAlert, sendAlertReport, setAlertReport, type AlertReport } from "./alert-report";
import { LlmAlertNotifier } from "./llm-monitor";
import { ProviderQuotaNotifier } from "./provider-quota";
import { SpendAlertNotifier, type ReadEnv } from "./spend-alerts";

// docs/phases/PHASE_20.md P20-13: every founder alert also goes to the
// second channel the web app installs (Sentry), and trigger/src stays free
// of Sentry.

const MAIL_ENV: Record<string, string> = { RESEND_API_KEY: "re_test", FOUNDER_ALERT_EMAIL: "founder@example.com" };

function env(values: Record<string, string>): ReadEnv {
  return (name) => values[name];
}

function fetchWith(status: number): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => new Response(status === 200 ? "{}" : "nope", { status });
}

function quietLog() {
  return { error: vi.fn<Console["error"]>(), warn: vi.fn<Console["warn"]>() };
}

type Reported = { message: string; tags: Record<string, string>; level?: string };

function recorder(): { reported: Reported[]; report: AlertReport } {
  const reported: Reported[] = [];
  return { reported, report: (message, tags, level) => reported.push({ message, tags, level }) };
}

afterEach(() => {
  setAlertReport(null);
});

describe("the process wide hook", () => {
  it("is a no op until the web app installs one", () => {
    expect(hasAlertReport()).toBe(false);
    expect(() => reportAlert("nothing listens", { alert: "test" })).not.toThrow();
  });

  it("hands each alert to the installed hook, warning by default", () => {
    const { reported, report } = recorder();
    setAlertReport(report);
    expect(hasAlertReport()).toBe(true);
    reportAlert("one", { alert: "a", period: "2026-10-01" });
    reportAlert("two", { alert: "b" }, "error");
    expect(reported).toEqual([
      { message: "one", tags: { alert: "a", period: "2026-10-01" }, level: "warning" },
      { message: "two", tags: { alert: "b" }, level: "error" },
    ]);
    setAlertReport(null);
    reportAlert("three", { alert: "c" });
    expect(reported).toHaveLength(2);
  });

  it("never lets a throwing hook escape", () => {
    setAlertReport(() => {
      throw new Error("sentry exploded");
    });
    expect(() => reportAlert("x", { alert: "a" })).not.toThrow();
    expect(() =>
      sendAlertReport(
        () => {
          throw new Error("injected exploded");
        },
        "x",
        { alert: "a" },
      ),
    ).not.toThrow();
  });
});

describe("SpendAlertNotifier second channel", () => {
  it("reports each alert once per kind and day, as an error for the hard stop", async () => {
    const { reported, report } = recorder();
    const notifier = new SpendAlertNotifier({
      readEnv: env(MAIL_ENV),
      fetchImpl: fetchWith(200),
      now: () => new Date("2026-10-01T10:00:00Z"),
      log: quietLog(),
      report,
    });

    await notifier.notify("spend_alert", 51_000_000);
    await notifier.notify("spend_alert", 60_000_000);
    await notifier.notify("hard_stop", 150_000_000);

    expect(reported.map((r) => [r.tags, r.level])).toEqual([
      [{ alert: "spend_alert", period: "2026-10-01" }, "warning"],
      [{ alert: "hard_stop", period: "2026-10-01" }, "error"],
    ]);
    expect(reported[0].message).toContain("2026-10-01");
  });

  it("still reports when the email cannot be sent, and a throwing hook never stops the email", async () => {
    const failing = recorder();
    const noMail = new SpendAlertNotifier({ readEnv: env({}), log: quietLog(), report: failing.report });
    expect((await noMail.notify("hard_stop", 150_000_000)).delivered).toBe("log");
    expect(failing.reported).toHaveLength(1);

    const calls: string[] = [];
    const notifier = new SpendAlertNotifier({
      readEnv: env(MAIL_ENV),
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      },
      log: quietLog(),
      report: () => {
        throw new Error("sentry down");
      },
    });
    expect((await notifier.notify("spend_alert", 50_000_000)).delivered).toBe("email");
    expect(calls).toHaveLength(1);
  });

  it("uses the process wide hook when none is injected", async () => {
    const { reported, report } = recorder();
    setAlertReport(report);
    const notifier = new SpendAlertNotifier({ readEnv: env({}), log: quietLog() });
    await notifier.notify("spend_alert", 50_000_000);
    expect(reported).toHaveLength(1);
    expect(reported[0].tags.alert).toBe("spend_alert");
  });
});

describe("LlmAlertNotifier second channel", () => {
  it("reports each alert once per period, the quota alert as an error", async () => {
    const { reported, report } = recorder();
    const alerts = new LlmAlertNotifier({ readEnv: env(MAIL_ENV), fetchImpl: fetchWith(200), log: quietLog(), report });
    const email = { subject: "Curvi: OpenAI answered out of quota", text: "body" };

    await alerts.notify("llm_quota", "openai:2026-10-01T10", email, {});
    await alerts.notify("llm_quota", "openai:2026-10-01T10", email, {});
    await alerts.notify("llm_fallback", "2026-10-01T10", { subject: "fallback", text: "body" }, {});

    expect(reported).toEqual([
      { message: email.subject, tags: { alert: "llm_quota", period: "openai:2026-10-01T10" }, level: "error" },
      { message: "fallback", tags: { alert: "llm_fallback", period: "2026-10-01T10" }, level: "warning" },
    ]);
  });
});

describe("ProviderQuotaNotifier second channel", () => {
  it("reports once per provider per window, as an error with the provider tags", async () => {
    const { reported, report } = recorder();
    let now = Date.parse("2026-10-01T10:15:00Z");
    const notifier = new ProviderQuotaNotifier({ now: () => now, log: quietLog(), report });

    await notifier.notify({ provider: "fal-birefnet", task: "cutout" } as never);
    await notifier.notify({ provider: "fal-birefnet", task: "cutout" } as never);
    now += 61 * 60_000;
    await notifier.notify({ provider: "fal-birefnet", task: "cutout" } as never);

    expect(reported).toHaveLength(2);
    expect(reported[0]).toEqual({
      message: "fal-birefnet answered that its account is out of quota or credit",
      tags: { alert: "provider_quota", provider: "fal-birefnet", task: "cutout", period: "2026-10-01T10" },
      level: "error",
    });
    expect(reported[1].tags.period).toBe("2026-10-01T11");
  });
});
