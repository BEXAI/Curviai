/**
 * fal balance probe, low balance alerts and quota emails (docs/phases/
 * PHASE_18.md P18-03, founder decision 8), against PGlite for the stored
 * reading and the shared claims. The probe and Resend are always fakes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Db } from "@curvi/db";
import { events } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import type { FalBalanceResult } from "@curvi/ai";
import { falBalanceLines } from "@curvi/pipeline/seed";
import { PgCapStore } from "./cap-store";
import {
  FounderAlerts,
  PAUSE_ADS_LINE,
  PROVIDER_BALANCE_EVENT,
  checkFalBalances,
  composeAcquisitionPausedEmail,
  composeFalBalanceEmail,
  falBalanceBand,
  notifyAcquisitionPaused,
  readFalBalances,
} from "./provider-balance";
import { ProviderQuotaNotifier, composeProviderQuotaEmail } from "./provider-quota";

let created: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;

const ADMIN_KEY = "fal-admin-secret-value";
const silent = { warn: () => {}, error: () => {} };

beforeAll(async () => {
  created = await createTestDb();
  db = created.db as unknown as Db;
});

afterAll(async () => {
  await created.client.close();
});

beforeEach(async () => {
  await created.client.exec("delete from spend_cap_counters; delete from events; delete from platform_settings");
});

interface Sent {
  subject: string;
  text: string;
}

function resend(): { fetchImpl: typeof fetch; sent: Sent[]; urls: string[] } {
  const sent: Sent[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    sent.push({ subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, urls };
}

const env: Record<string, string> = {
  FAL_KEY: "fal-inference",
  FAL_ADMIN_KEY: ADMIN_KEY,
  RESEND_API_KEY: "re_test",
  FOUNDER_ALERT_EMAIL: "founder@example.test",
};
const readEnv = (name: string) => env[name];

function probeAnswering(...answers: Array<Partial<FalBalanceResult>>) {
  const keys: string[] = [];
  let i = 0;
  const probe = async ({ adminKey }: { adminKey: string }): Promise<FalBalanceResult> => {
    keys.push(adminKey);
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return { ok: true, status: 200, balanceUsd: null, currency: "USD", latencyMs: 1, ...answer };
  };
  return { probe, keys };
}

describe("falBalanceBand", () => {
  it("places a balance against the seeded lines", () => {
    expect(falBalanceBand(20)).toBe("ok");
    expect(falBalanceBand(falBalanceLines.alertUsd)).toBe("ok");
    expect(falBalanceBand(14.99)).toBe("alert");
    expect(falBalanceBand(falBalanceLines.pauseUsd)).toBe("alert");
    expect(falBalanceBand(2.5)).toBe("pause");
    expect(falBalanceBand(0)).toBe("pause");
    expect(falBalanceBand(null)).toBe("unknown");
  });
});

describe("checkFalBalances", () => {
  it("probes only accounts whose admin key is set, with the admin key", async () => {
    const { probe, keys } = probeAnswering({ balanceUsd: 40 });
    const mail = resend();
    const reports = await checkFalBalances({ db, dedupe: new PgCapStore(db), readEnv, fetchImpl: mail.fetchImpl, probe, log: silent });
    expect(keys).toEqual([ADMIN_KEY]);
    expect(reports.map((r) => [r.provider, r.probed, r.band])).toEqual([
      ["fal-birefnet", true, "ok"],
      ["fal-birefnet-backup", false, "unknown"],
    ]);
    expect(reports[0].keyConfigured).toBe(true);
    expect(mail.sent).toEqual([]);
    expect(JSON.stringify(reports)).not.toContain(ADMIN_KEY);
  });

  it("stores the reading and keeps the last good balance through a failed probe", async () => {
    const at = new Date("2026-10-01T10:00:00Z");
    const ok = probeAnswering({ balanceUsd: 12.5 });
    await checkFalBalances({ db, readEnv: (n) => (n === "FAL_ADMIN_KEY" ? ADMIN_KEY : undefined), probe: ok.probe, now: () => at, log: silent });
    let stored = (await readFalBalances(db)).get("fal-birefnet");
    expect(stored).toMatchObject({ ok: true, balanceUsd: 12.5, currency: "USD", balanceAt: at.toISOString(), checkedAt: at.toISOString() });

    const later = new Date("2026-10-01T10:15:00Z");
    const failed = probeAnswering({ ok: false, status: 503, balanceUsd: null, currency: null });
    await checkFalBalances({ db, readEnv: (n) => (n === "FAL_ADMIN_KEY" ? ADMIN_KEY : undefined), probe: failed.probe, now: () => later, log: silent });
    stored = (await readFalBalances(db)).get("fal-birefnet");
    expect(stored).toMatchObject({ ok: false, status: 503, balanceUsd: 12.5, balanceAt: at.toISOString(), checkedAt: later.toISOString() });
  });

  it("writes a provider_balance event at most once an hour per account", async () => {
    const store = new PgCapStore(db);
    const { probe } = probeAnswering({ balanceUsd: 40 });
    const base = { db, dedupe: store, readEnv: (n: string) => (n === "FAL_ADMIN_KEY" ? ADMIN_KEY : undefined), probe, log: silent };
    const first = await checkFalBalances({ ...base, now: () => new Date("2026-10-01T10:05:00Z") });
    const again = await checkFalBalances({ ...base, now: () => new Date("2026-10-01T10:20:00Z") });
    const nextHour = await checkFalBalances({ ...base, now: () => new Date("2026-10-01T11:01:00Z") });
    expect([first[0].eventRecorded, again[0].eventRecorded, nextHour[0].eventRecorded]).toEqual([true, false, true]);
    const rows = await created.db.select().from(events);
    expect(rows.map((r) => r.name)).toEqual([PROVIDER_BALANCE_EVENT, PROVIDER_BALANCE_EVENT]);
    expect(rows[0].workspaceId).toBeNull();
    expect(rows[0].props).toMatchObject({ provider: "fal-birefnet", balanceUsd: 40, band: "ok" });
    expect(JSON.stringify(rows)).not.toContain(ADMIN_KEY);
  });

  it("emails the founder once per UTC day per account below the alert line", async () => {
    const store = new PgCapStore(db);
    const mail = resend();
    const { probe } = probeAnswering({ balanceUsd: 9.4 });
    const run = (iso: string) =>
      checkFalBalances({ db, dedupe: store, alerts: new FounderAlerts({ dedupe: store, readEnv, fetchImpl: mail.fetchImpl, log: silent }), readEnv, probe, now: () => new Date(iso), log: silent });
    expect((await run("2026-10-01T09:00:00Z"))[0].alert).toBe("low");
    expect((await run("2026-10-01T18:00:00Z"))[0].alert).toBeNull();
    expect((await run("2026-10-02T00:10:00Z"))[0].alert).toBe("low");
    expect(mail.sent.map((m) => m.subject)).toEqual([
      "Curvi: the fal balance is low ($9.40 left)",
      "Curvi: the fal balance is low ($9.40 left)",
    ]);
    expect(mail.urls.every((u) => u === "https://api.resend.com/emails")).toBe(true);
  });

  it("emails at once below the pause line, even after the day's low email", async () => {
    const store = new PgCapStore(db);
    const mail = resend();
    const { probe } = probeAnswering({ balanceUsd: 9 }, { balanceUsd: 2.1 }, { balanceUsd: 1.9 });
    const run = () =>
      checkFalBalances({ db, dedupe: store, alerts: new FounderAlerts({ dedupe: store, readEnv, fetchImpl: mail.fetchImpl, log: silent }), readEnv, probe, now: () => new Date("2026-10-01T12:00:00Z"), log: silent });
    expect((await run())[0].alert).toBe("low");
    expect((await run())[0].alert).toBe("pause");
    expect((await run())[0].alert).toBeNull();
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].subject).toBe("Curvi: the fal balance is low ($2.10 left)");
    expect(mail.sent[1].text).toContain("below the pause line of $3.00");
    expect(mail.sent[1].text).toContain(PAUSE_ADS_LINE);
  });

  it("logs the alert and tries again later when Resend is down", async () => {
    const store = new PgCapStore(db);
    let calls = 0;
    const down = (async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const { probe } = probeAnswering({ balanceUsd: 1 });
    const run = () =>
      checkFalBalances({ db, dedupe: store, alerts: new FounderAlerts({ dedupe: store, readEnv, fetchImpl: down, log: silent }), readEnv, probe, log: silent });
    expect((await run())[0].alert).toBe("pause");
    expect((await run())[0].alert).toBe("pause");
    expect(calls).toBe(2);
  });
});

describe("founder emails", () => {
  const banned = /[–—]| - |->|=>|→/;

  it("are plain spoken, with no dashes as punctuation and no arrows", () => {
    const emails = [
      composeFalBalanceEmail({ provider: "fal-birefnet", keyEnv: "FAL_KEY" }, 9.5, "alert"),
      composeFalBalanceEmail({ provider: "fal-birefnet", keyEnv: "FAL_KEY" }, 1, "pause"),
      composeAcquisitionPausedEmail("packs_paused"),
      composeAcquisitionPausedEmail("fal_balance"),
      composeProviderQuotaEmail("cutout", { provider: "fal-birefnet", task: "cutout", message: "403" }, "2026-10-01T10"),
      composeProviderQuotaEmail("image", { provider: "gemini-image", task: "scene_plate", message: "429" }, "2026-10-01T10"),
    ];
    for (const email of emails) {
      expect(email.subject).not.toMatch(banned);
      expect(email.text).not.toMatch(banned);
    }
    expect(composeAcquisitionPausedEmail("fal_balance").subject).toBe("Curvi: acquisition is paused because packs cannot run");
  });

  it("sends the acquisition paused email once per UTC day and reason", async () => {
    const store = new PgCapStore(db);
    const mail = resend();
    const alerts = new FounderAlerts({ dedupe: store, readEnv, fetchImpl: mail.fetchImpl, log: silent });
    const at = new Date("2026-10-01T08:00:00Z");
    expect(await notifyAcquisitionPaused("fal_balance", alerts, at)).toBe("email");
    expect(await notifyAcquisitionPaused("fal_balance", alerts, at)).toBe("deduped");
    expect(await notifyAcquisitionPaused("packs_paused", alerts, at)).toBe("email");
    expect(mail.sent[0].text).toContain(PAUSE_ADS_LINE);
  });
});

describe("ProviderQuotaNotifier founder email (P18-03)", () => {
  it("emails once per cutout, image or LLM provider per UTC hour across processes", async () => {
    const store = new PgCapStore(db);
    const mail = resend();
    const now = Date.parse("2026-10-01T10:30:00Z");
    const make = () =>
      new ProviderQuotaNotifier({ now: () => now, log: silent, alerts: new FounderAlerts({ dedupe: store, readEnv, fetchImpl: mail.fetchImpl, log: silent }) });
    const a = make();
    const b = make();
    await a.notify({ provider: "fal-birefnet", task: "cutout", message: "403" });
    await b.notify({ provider: "fal-birefnet", task: "cutout", message: "403" });
    await a.notify({ provider: "gemini-image", task: "scene_plate", message: "429" });
    await a.notify({ provider: "openai:gpt-6-luna", task: "shot_planner", message: "429" });
    await Promise.all([a.flush(), b.flush()]);
    expect(mail.sent.map((m) => m.subject).sort()).toEqual([
      "Curvi: fal-birefnet says the account is out of quota or credit",
      "Curvi: gemini-image says the account is out of quota or credit",
      "Curvi: openai:gpt-6-luna says the account is out of quota or credit",
    ]);
  });

  it("sends nothing without alerts wired, as before", async () => {
    const mail = resend();
    const notifier = new ProviderQuotaNotifier({ log: silent });
    await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "403" });
    await notifier.flush();
    expect(mail.sent).toEqual([]);
  });
});

describe("readFalBalances", () => {
  it("reads only fal_balance rows", async () => {
    await created.client.exec(`insert into platform_settings (key, value) values ('cron:stale-jobs:last_success', '{"at":"x"}'::jsonb)`);
    await db.execute(
      sql`insert into platform_settings (key, value) values ('fal_balance:fal-birefnet', ${JSON.stringify({ ok: true, balanceUsd: 5, balanceAt: "2026-10-01T00:00:00.000Z" })}::jsonb)`,
    );
    const read = await readFalBalances(db);
    expect([...read.keys()]).toEqual(["fal-birefnet"]);
    expect(read.get("fal-birefnet")).toMatchObject({ balanceUsd: 5, ok: true });
  });
});
