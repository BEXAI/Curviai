import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryCapStore, SPEND_CAPS, SpendCaps } from "@curvi/ai";
import { eq, type Db } from "@curvi/db";
import { events } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import { PgCapStore } from "./cap-store";
import { RESEND_EMAILS_URL } from "./digest";
import {
  DEFAULT_ALERT_FROM,
  InMemoryAlertDedupe,
  SpendAlertNotifier,
  composeSpendAlert,
  hardStopMicros,
  watchGlobalSpend,
  type ReadEnv,
} from "./spend-alerts";

type Call = { url: string; init: RequestInit };

function fakeFetch(status = 200): { calls: Call[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response(status === 200 ? JSON.stringify({ id: "email_1" }) : "bad request", { status });
    },
  };
}

function env(values: Record<string, string>): ReadEnv {
  return (name) => values[name];
}

const MAIL_ENV = { RESEND_API_KEY: "re_test", FOUNDER_ALERT_EMAIL: "founder@example.com" };

function quietLog(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("SpendAlertNotifier", () => {
  it("emails the founder through Resend once per kind and UTC day", async () => {
    const { calls, fetchImpl } = fakeFetch();
    let now = new Date("2026-09-28T10:00:00Z");
    const notifier = new SpendAlertNotifier({ readEnv: env(MAIL_ENV), fetchImpl, now: () => now, log: quietLog() });

    const first = await notifier.notify("spend_alert", 51_250_000);
    expect(first).toMatchObject({ deduped: false, delivered: "email", day: "2026-09-28" });
    expect((await notifier.notify("spend_alert", 60_000_000)).deduped).toBe(true);
    expect((await notifier.notify("hard_stop", 150_000_000)).delivered).toBe("email");
    expect((await notifier.notify("hard_stop", 150_000_000)).deduped).toBe(true);
    now = new Date("2026-09-29T00:05:00Z");
    expect((await notifier.notify("spend_alert", 52_000_000)).deduped).toBe(false);

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(RESEND_EMAILS_URL);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(calls[0].init.body)) as { from: string; to: string[]; subject: string; text: string };
    expect(body.to).toEqual(["founder@example.com"]);
    expect(body.from).toBe(DEFAULT_ALERT_FROM);
    expect(body.subject).toContain("2026-09-28");
    expect(body.text).toContain("$51.25");
    const stop = JSON.parse(String(calls[1].init.body)) as { subject: string; text: string };
    expect(stop.subject).toContain("hard stop");
  });

  it("uses FOUNDER_ALERT_FROM when set", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new SpendAlertNotifier({
      readEnv: env({ ...MAIL_ENV, FOUNDER_ALERT_FROM: "Ops <ops@example.com>" }),
      fetchImpl,
      log: quietLog(),
    });
    await notifier.notify("spend_alert", 50_000_000);
    expect(JSON.parse(String(calls[0].init.body)).from).toBe("Ops <ops@example.com>");
  });

  it("logs a structured error when email is not configured", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const log = quietLog();
    const notifier = new SpendAlertNotifier({ readEnv: env({}), fetchImpl, log, now: () => new Date("2026-09-28T01:00:00Z") });
    const result = await notifier.notify("hard_stop", 149_990_000);
    expect(result.delivered).toBe("log");
    expect(calls).toHaveLength(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.error.mock.calls[0][0])) as Record<string, unknown>;
    expect(line).toMatchObject({ level: "error", event: "provider_spend_hard_stop", day: "2026-09-28", totalUsd: 149.99 });
    expect(String(line.notice)).toContain("FOUNDER_ALERT_EMAIL");
  });

  it("falls back to the structured log when Resend fails or cannot be reached", async () => {
    const log = quietLog();
    const failing = new SpendAlertNotifier({ readEnv: env(MAIL_ENV), fetchImpl: fakeFetch(500).fetchImpl, log });
    expect((await failing.notify("spend_alert", 50_000_000)).delivered).toBe("log");
    const offline = new SpendAlertNotifier({
      readEnv: env(MAIL_ENV),
      fetchImpl: async () => {
        throw new Error("network down");
      },
      log,
    });
    const result = await offline.notify("spend_alert", 50_000_000);
    expect(result.delivered).toBe("log");
    expect(result.notice).toContain("network down");
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("still alerts when the shared dedupe store is unavailable", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new SpendAlertNotifier({
      readEnv: env(MAIL_ENV),
      fetchImpl,
      log: quietLog(),
      dedupe: {
        claim: async () => {
          throw new Error("db down");
        },
      },
    });
    expect((await notifier.notify("spend_alert", 50_000_000)).delivered).toBe("email");
    // The in process guard still keeps it to one.
    expect((await notifier.notify("spend_alert", 70_000_000)).deduped).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("never throws out of the fire and forget hooks", async () => {
    const log = quietLog();
    const notifier = new SpendAlertNotifier({
      readEnv: () => {
        throw new Error("env exploded");
      },
      log,
    });
    expect(() => notifier.onSpendAlert(50_000_000)).not.toThrow();
    await notifier.flush();
    expect(log.error).toHaveBeenCalled();
  });
});

describe("spend alerts across processes (Postgres dedupe and events)", () => {
  let created: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;

  beforeAll(async () => {
    created = await createTestDb();
    db = created.db as unknown as Db;
  });

  afterAll(async () => {
    await created.client.close();
  });

  it("sends one email and records one events row when two workers cross the line", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const now = () => new Date("2026-09-28T12:00:00Z");
    const store = new PgCapStore(db);
    const workerA = new SpendAlertNotifier({ db, dedupe: store, readEnv: env(MAIL_ENV), fetchImpl, now, log: quietLog() });
    const workerB = new SpendAlertNotifier({ db, dedupe: store, readEnv: env(MAIL_ENV), fetchImpl, now, log: quietLog() });

    const results = await Promise.all([
      workerA.notify("spend_alert", 50_100_000),
      workerB.notify("spend_alert", 50_200_000),
    ]);
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
    expect(results.find((r) => !r.deduped)?.eventRecorded).toBe(true);
    expect(calls).toHaveLength(1);

    const rows = await created.db.select().from(events).where(eq(events.name, "provider_spend_alert"));
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBeNull();
    expect(rows[0].props).toMatchObject({ day: "2026-09-28", delivered: "email" });
  });
});

describe("watchGlobalSpend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the alert line on allowed reservations and the hard stop on refused ones", async () => {
    const caps = new SpendCaps(new InMemoryCapStore(), () => new Date("2026-09-28T00:00:00Z"));
    const onSpendAlert = vi.fn();
    const onHardStop = vi.fn();
    watchGlobalSpend(caps, { onSpendAlert, onHardStop });
    watchGlobalSpend(caps, { onSpendAlert, onHardStop });

    await caps.checkAndReserveGlobalDay(SPEND_CAPS.globalDailyAlertMicros - 1);
    expect(onSpendAlert).not.toHaveBeenCalled();
    await caps.checkAndReserveGlobalDay(1);
    expect(onSpendAlert).toHaveBeenCalledTimes(1);
    expect(onSpendAlert).toHaveBeenCalledWith(SPEND_CAPS.globalDailyAlertMicros);

    const refused = await caps.checkAndReserveGlobalDay(SPEND_CAPS.globalDailyHardStopMicros);
    expect(refused.allowed).toBe(false);
    expect(onHardStop).toHaveBeenCalledTimes(1);
    expect(onHardStop).toHaveBeenCalledWith(SPEND_CAPS.globalDailyAlertMicros);
  });

  it("keeps the reservation result when a notifier throws", async () => {
    const caps = new SpendCaps(new InMemoryCapStore());
    watchGlobalSpend(caps, {
      onSpendAlert: () => {
        throw new Error("boom");
      },
      onHardStop: () => {
        throw new Error("boom");
      },
    });
    const result = await caps.checkAndReserveGlobalDay(SPEND_CAPS.globalDailyAlertMicros);
    expect(result.allowed).toBe(true);
  });

  it("wires a notifier end to end: one founder alert for a day of spend past the line", async () => {
    const caps = new SpendCaps(new InMemoryCapStore(), () => new Date("2026-09-28T00:00:00Z"));
    const { calls, fetchImpl } = fakeFetch();
    const notifier = new SpendAlertNotifier({
      readEnv: env(MAIL_ENV),
      fetchImpl,
      dedupe: new InMemoryAlertDedupe(),
      now: () => new Date("2026-09-28T09:00:00Z"),
      log: quietLog(),
    });
    watchGlobalSpend(caps, notifier);
    for (let i = 0; i < 5; i++) {
      await caps.checkAndReserveGlobalDay(SPEND_CAPS.globalDailyAlertMicros / 2);
    }
    await caps.checkAndReserveGlobalDay(SPEND_CAPS.globalDailyHardStopMicros);
    await notifier.flush();
    const subjects = calls.map((c) => JSON.parse(String(c.init.body)).subject as string);
    expect(subjects).toHaveLength(2);
    expect(subjects.some((s) => s.includes("hard stop"))).toBe(true);
  });
});

describe("alert copy", () => {
  it("names the hard stop in force, including the founder's raise", () => {
    expect(hardStopMicros(env({}))).toBe(SPEND_CAPS.globalDailyHardStopMicros);
    expect(hardStopMicros(env({ DAILY_SPEND_HARD_STOP_USD: "300" }))).toBe(300_000_000);
    expect(hardStopMicros(env({ DAILY_SPEND_HARD_STOP_USD: "nope" }))).toBe(SPEND_CAPS.globalDailyHardStopMicros);
    const email = composeSpendAlert("hard_stop", 300_000_000, "2026-09-28", 300_000_000);
    expect(email.text).toContain("$300.00");
  });

  it("keeps the copy plain: no arrows, no emojis and no dashes as punctuation", () => {
    for (const kind of ["spend_alert", "hard_stop"] as const) {
      const email = composeSpendAlert(kind, 51_000_000, "2026-09-28", 150_000_000);
      const copy = `${email.subject}\n${email.text}`.replaceAll("2026-09-28", "");
      expect(copy).not.toMatch(/[–—→⇒]|->|=>| - /);
      expect(copy).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
