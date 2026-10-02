import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  callWithFailover,
  InMemoryBreakerStore,
  ProviderError,
  ProviderRegistry,
  type CostMeterEntry,
  type LlmResult,
  type LlmUsage,
} from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { eq, type Db } from "@curvi/db";
import { events } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import { llmCreditWindows, llmFallbackAlertPolicy } from "@curvi/pipeline/seed";
import { PgCapStore } from "./cap-store";
import { RESEND_EMAILS_URL } from "./email-transport";
import { InMemoryAlertDedupe, sendFounderEmail } from "./spend-alerts";
import {
  InMemoryLlmCounterStore,
  LLM_ALERT_EVENT_NAMES,
  LlmAlertNotifier,
  LlmMonitor,
  LlmMonitorMeter,
  LLM_ALERT_RETRY_MS,
  composeCreditExpiryReminder,
  composeFallbackAlert,
  dueCreditReminder,
  fallbackShareExceeded,
  lastUtcDays,
  llmCounterDeltas,
  llmDayKey,
  llmFamilyOfEntry,
  llmHourKey,
  llmJobKey,
  llmSpendReport,
  packLlmSpend,
} from "./llm-monitor";

const AT = new Date("2026-10-01T14:20:00Z");
const LUNA = "openai:gpt-6-luna";
const SOL = "openai:gpt-6.1-sol";
const SONNET = "anthropic:claude-sonnet-5";

function usage(input: number, cached: number, output: number, reasoning: number): LlmUsage {
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning };
}

function entry(overrides: Partial<CostMeterEntry> = {}): CostMeterEntry {
  return {
    provider: LUNA,
    task: "intake_normalizer",
    costMicros: 100,
    latencyMs: 900,
    ok: true,
    attempt: 1,
    at: AT,
    jobId: "job-1",
    workspaceId: "ws-1",
    primaryProvider: LUNA,
    usage: usage(2_000, 1_024, 500, 300),
    ...overrides,
  };
}

function quietLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mailer() {
  const sent: Array<{ subject: string; text: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(RESEND_EMAILS_URL);
    const body = JSON.parse(String(init?.body)) as { subject: string; text: string };
    sent.push({ subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  });
  const readEnv = (name: string) =>
    ({ RESEND_API_KEY: "re_test", FOUNDER_ALERT_EMAIL: "founder@example.com" })[name];
  return { sent, fetchImpl, readEnv };
}

function monitorWith(opts: { now?: () => Date } = {}) {
  const mail = mailer();
  const log = quietLog();
  const store = new InMemoryLlmCounterStore();
  const alerts = new LlmAlertNotifier({ readEnv: mail.readEnv, fetchImpl: mail.fetchImpl, log });
  const monitor = new LlmMonitor({ store, alerts, log, now: opts.now ?? (() => AT) });
  return { monitor, store, mail, log };
}

describe("llmCounterDeltas", () => {
  it("meters cached input and reasoning tokens apart, per day, recipe and provider, plus pack spend per family", () => {
    const deltas = llmCounterDeltas(entry(), "openai");
    const byKey = new Map(deltas.map((d) => [d.key, d.delta]));
    const key = (metric: Parameters<typeof llmDayKey>[3]) => llmDayKey("2026-10-01", "intake_normalizer", LUNA, metric);
    expect(byKey.get(key("calls"))).toBe(1);
    expect(byKey.get(key("cost_micros"))).toBe(100);
    expect(byKey.get(key("input_tokens"))).toBe(2_000);
    expect(byKey.get(key("cached_input_tokens"))).toBe(1_024);
    expect(byKey.get(key("output_tokens"))).toBe(500);
    expect(byKey.get(key("reasoning_tokens"))).toBe(300);
    expect(byKey.has(key("failed"))).toBe(false);
    expect(byKey.get(llmJobKey("job-1", "openai"))).toBe(100);
    expect(byKey.get(llmHourKey("2026-10-01T14", "primary_calls"))).toBe(1);
    expect(byKey.get(llmHourKey("2026-10-01T14", "fallback_calls"))).toBe(0);
  });

  it("counts a Claude answer to an OpenAI first chain as a fallback, and a failed attempt as failed only", () => {
    const served = new Map(llmCounterDeltas(entry({ provider: SONNET }), "anthropic").map((d) => [d.key, d.delta]));
    expect(served.get(llmHourKey("2026-10-01T14", "fallback_calls"))).toBe(1);
    expect(served.get(llmJobKey("job-1", "anthropic"))).toBe(100);

    const failed = new Map(
      llmCounterDeltas(entry({ ok: false, costMicros: 0, usage: undefined, errorCode: "provider_quota" }), "openai").map((d) => [
        d.key,
        d.delta,
      ]),
    );
    expect(failed.get(llmDayKey("2026-10-01", "intake_normalizer", LUNA, "failed"))).toBe(1);
    expect([...failed.keys()].some((k) => k.includes("|hour|"))).toBe(false);
    expect([...failed.keys()].some((k) => k.includes("|job|"))).toBe(false);

    // A recipe still served by Claude first (the canary) is not a fallback.
    const claudeFirst = llmCounterDeltas(entry({ provider: SONNET, primaryProvider: SONNET }), "anthropic");
    expect(claudeFirst.some((d) => d.key.includes("|hour|"))).toBe(false);
  });

  it("tells LLM attempts from image and cutout calls", () => {
    expect(llmFamilyOfEntry({ provider: LUNA })).toBe("openai");
    expect(llmFamilyOfEntry({ provider: SONNET })).toBe("anthropic");
    expect(llmFamilyOfEntry({ provider: "openai-image" })).toBeNull();
    expect(llmFamilyOfEntry({ provider: "fal-birefnet" })).toBeNull();
    expect(llmFamilyOfEntry({ provider: "mock-llm", usage: usage(1, 0, 1, 0) })).toBe("other");
  });
});

describe("LlmMonitor counters and the cost report", () => {
  it("reports LLM spend and tokens per provider family and per recipe, and per pack", async () => {
    const { monitor, store, log } = monitorWith();
    const meter = new LlmMonitorMeter(monitor);
    await meter.record(entry());
    await meter.record(entry({ provider: SOL, task: "product_analyzer", costMicros: 4_000, usage: usage(3_000, 0, 1_500, 1_200) }));
    await meter.record(entry({ provider: SONNET, costMicros: 9_000, usage: usage(2_000, 0, 600, 0) }));
    await meter.record(entry({ provider: "nano-banana-2", task: "scene_plate", costMicros: 39_000, usage: undefined }));
    await monitor.flush();

    // The in memory meter still sees every attempt.
    expect(meter.entries).toHaveLength(4);
    expect(meter.llmUsageForTask("intake_normalizer").reasoningTokens).toBe(300);

    const report = await llmSpendReport(store, lastUtcDays(AT, 7));
    expect(report.days).toHaveLength(7);
    expect(report.days[6]).toBe("2026-10-01");
    expect(report.byFamily.openai).toMatchObject({
      calls: 2,
      costMicros: 4_100,
      inputTokens: 5_000,
      cachedInputTokens: 1_024,
      outputTokens: 2_000,
      reasoningTokens: 1_500,
      failed: 0,
    });
    expect(report.byFamily.anthropic).toMatchObject({ calls: 1, costMicros: 9_000 });
    expect(report.totalMicros).toBe(13_100);
    expect(report.rows.map((r) => `${r.recipe}@${r.provider}`)).toEqual([
      `intake_normalizer@${SONNET}`,
      `intake_normalizer@${LUNA}`,
      `product_analyzer@${SOL}`,
    ]);
    expect(await packLlmSpend(store, "job-1")).toEqual({ openai: 4_100, anthropic: 9_000 });

    // One llm_call line per LLM attempt, with the reasoning tokens.
    const lines = log.info.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ event: "llm_call", recipe: "product_analyzer", reasoningTokens: 1_200, fallback: true });
    expect(lines[0]).toMatchObject({ fallback: false, cachedInputTokens: 1_024 });
  });

  it("logs and carries on when the counter store fails", async () => {
    const log = quietLog();
    const monitor = new LlmMonitor({
      store: { addMany: () => Promise.reject(new Error("db down")), listByPrefix: async () => new Map() },
      alerts: new LlmAlertNotifier({ log }),
      log,
      now: () => AT,
    });
    await expect(monitor.observe(entry())).resolves.toBeUndefined();
    expect(log.error.mock.calls.some((c) => String(c[0]).includes("llm_counters_failed"))).toBe(true);
  });
});

describe("Claude fallback alert", () => {
  it("fires once an hour when Claude serves more than 5 percent of OpenAI first calls", async () => {
    expect(fallbackShareExceeded(19, 19)).toBe(false); // below the minimum sample
    expect(fallbackShareExceeded(20, 1)).toBe(false); // exactly 5 percent
    expect(fallbackShareExceeded(20, 2)).toBe(true);

    const { monitor, mail } = monitorWith();
    for (let i = 0; i < 18; i += 1) await monitor.observe(entry());
    await monitor.observe(entry({ provider: SONNET }));
    expect(mail.sent).toHaveLength(0);
    await monitor.observe(entry({ provider: SONNET })); // 2 of 20
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toContain("Claude served 10.0 percent of OpenAI calls");
    await monitor.observe(entry({ provider: SONNET }));
    expect(mail.sent).toHaveLength(1);

    // A new hour starts its own count.
    const next = new Date("2026-10-01T15:01:00Z");
    for (let i = 0; i < 19; i += 1) await monitor.observe(entry({ at: next }));
    await monitor.observe(entry({ at: next, provider: SONNET }));
    expect(mail.sent).toHaveLength(1);
  });

  it("checks the share on later primary calls too, once the hour reaches the minimum", async () => {
    const { monitor, mail } = monitorWith();
    for (let i = 0; i < 3; i += 1) await monitor.observe(entry({ provider: SONNET }));
    for (let i = 0; i < 16; i += 1) await monitor.observe(entry());
    expect(mail.sent).toHaveLength(0);
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(1);
  });

  it("writes copy without dashes or arrows", () => {
    const text = composeFallbackAlert("2026-10-01T14", 40, 4, llmFallbackAlertPolicy).text;
    expect(text).toContain("4 of 40");
    expect(text).not.toMatch(/ - | – | — |->|→/);
  });
});

describe("OpenAI provider_quota alert", () => {
  it("alerts the founder on an OpenAI quota answer, once per hour, and ignores other families", async () => {
    const { monitor, mail } = monitorWith();
    await monitor.onProviderQuota({ provider: SONNET, task: "intake_normalizer", message: "credit balance too low" });
    expect(mail.sent).toHaveLength(0);
    await monitor.onProviderQuota({ provider: LUNA, task: "intake_normalizer", message: "credit_balance_exhausted" });
    await monitor.onProviderQuota({ provider: SOL, task: "product_analyzer", message: "credit_balance_exhausted" });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Curvi: OpenAI says the account is out of quota or credit");
    expect(mail.sent[0].text).toContain(LUNA);
  });

  it("alerts from a real failover: OpenAI out of credit, Claude serves the call", async () => {
    const { monitor, mail, store } = monitorWith();
    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        name: LUNA,
        failTimes: Infinity,
        failWith: () => new ProviderError("openai:gpt-6-luna responded 429: credit_balance_exhausted", LUNA, "copy_generator", false, undefined, {
          code: "provider_quota",
        }),
      }),
    );
    const answer: LlmResult = { json: { ok: true }, text: "", finish: "complete", usage: usage(800, 0, 200, 0), raw: {} };
    registry.register(new MockProvider({ name: SONNET, output: answer, costMicros: 3_600 }));
    const meter = new LlmMonitorMeter(monitor);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await callWithFailover(
        registry,
        {},
        meter,
        new InMemoryBreakerStore(),
        { task: "copy_generator", input: {}, jobId: "job-q", workspaceId: "ws-1" },
        { chain: [LUNA, SONNET], onProviderQuota: monitor.onProviderQuota },
      );
      expect(result.provider).toBe(SONNET);
      await monitor.flush();
    } finally {
      errorLog.mockRestore();
    }
    expect(mail.sent.map((m) => m.subject)).toEqual(["Curvi: OpenAI says the account is out of quota or credit"]);
    expect(await packLlmSpend(store, "job-q")).toEqual({ anthropic: 3_600 });
    const hour = new Date().toISOString().slice(0, 13);
    expect(store.totals.get(llmHourKey(hour, "fallback_calls"))).toBe(1);
  });
});

describe("monitoring stays off the provider call path", () => {
  it("returns from the meter without waiting on the counter store", async () => {
    let release: () => void = () => {};
    const hanging = new Promise<Map<string, number>>((resolve) => {
      release = () => resolve(new Map());
    });
    const log = quietLog();
    const monitor = new LlmMonitor({
      store: { addMany: () => hanging, listByPrefix: async () => new Map() },
      alerts: new LlmAlertNotifier({ log }),
      log,
      now: () => AT,
    });
    const meter = new LlmMonitorMeter(monitor);
    const outcome = await Promise.race([
      meter.record(entry()).then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 50)),
    ]);
    expect(outcome).toBe("returned");
    expect(meter.entries).toHaveLength(1);
    release();
    await monitor.flush();
  });

  it("fails over to Claude while the OpenAI quota email is still hanging", async () => {
    const log = quietLog();
    let sends = 0;
    const alerts = new LlmAlertNotifier({
      log,
      readEnv: mailer().readEnv,
      // Resend never answers until the send times out.
      fetchImpl: (_url, init) => {
        sends += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const monitor = new LlmMonitor({ alerts, log, now: () => AT });
    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        name: LUNA,
        failTimes: Infinity,
        failWith: () => new ProviderError("openai:gpt-6-luna responded 429: credit_balance_exhausted", LUNA, "copy_generator", false, undefined, {
          code: "provider_quota",
        }),
      }),
    );
    const answer: LlmResult = { json: { ok: true }, text: "", finish: "complete", usage: usage(800, 0, 200, 0), raw: {} };
    registry.register(new MockProvider({ name: SONNET, output: answer, costMicros: 3_600 }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const call = callWithFailover(
        registry,
        {},
        new LlmMonitorMeter(monitor),
        new InMemoryBreakerStore(),
        { task: "copy_generator", input: {}, jobId: "job-h", workspaceId: "ws-1" },
        { chain: [LUNA, SONNET], onProviderQuota: monitor.onProviderQuotaInBackground },
      );
      const outcome = await Promise.race([
        call.then((r) => r.provider),
        new Promise((resolve) => setTimeout(() => resolve("held"), 1_000)),
      ]);
      expect(outcome).toBe(SONNET);
      expect(sends).toBe(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("gives up a founder email that Resend never answers", async () => {
    const sent = await sendFounderEmail(
      { subject: "s", text: "t" },
      {
        readEnv: mailer().readEnv,
        timeoutMs: 20,
        fetchImpl: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
          }),
      },
    );
    expect(sent).toMatchObject({ ok: false, retryable: true });
  });
});

describe("a founder alert whose email fails", () => {
  it("is tried again after the retry wait instead of being used up", async () => {
    let now = new Date("2026-12-01T09:00:00Z");
    const log = quietLog();
    const mail = mailer();
    let failing = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      failing ? new Response("unavailable", { status: 503 }) : mail.fetchImpl(url, init),
    );
    const dedupe = new InMemoryAlertDedupe();
    const alerts = new LlmAlertNotifier({ readEnv: mail.readEnv, fetchImpl, log, dedupe, now: () => now });
    const monitor = new LlmMonitor({ alerts, log, now: () => now });

    await monitor.observe(entry());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mail.sent).toHaveLength(0);

    // Inside the retry wait: no new send.
    failing = false;
    now = new Date(now.getTime() + LLM_ALERT_RETRY_MS - 1_000);
    await monitor.observe(entry());
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After it: the reminder goes out, once.
    now = new Date(now.getTime() + 2_000);
    await monitor.observe(entry());
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Curvi: the OpenAI credits expire on 2026-12-31");
    // The shared claim is held again, so no other process sends it.
    expect(await dedupe.claim("alerts:llm_credit_expiry:openai:2026-12-01")).toBe(false);
  });

  it("keeps the claim when the email is not set up, so nothing retries", async () => {
    const log = quietLog();
    const fetchImpl = vi.fn();
    const dedupe = new InMemoryAlertDedupe();
    const alerts = new LlmAlertNotifier({ readEnv: () => undefined, fetchImpl, log, dedupe });
    const first = await alerts.notify("llm_quota", "openai:2026-12-01T09", { subject: "s", text: "t" }, {});
    expect(first).toMatchObject({ delivered: "log" });
    expect(first.retryScheduled).toBeUndefined();
    expect(await dedupe.claim("alerts:llm_quota:openai:2026-12-01T09")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OpenAI credit expiry reminders", () => {
  const openai = llmCreditWindows.find((w) => w.family === "openai")!;

  it("picks the seeded reminder due on a day, and none after the expiry", () => {
    expect(dueCreditReminder(openai, "2026-11-30")).toBeNull();
    expect(dueCreditReminder(openai, "2026-12-01")).toBe("2026-12-01");
    expect(dueCreditReminder(openai, "2026-12-23")).toBe("2026-12-01");
    expect(dueCreditReminder(openai, "2026-12-24")).toBe("2026-12-24");
    expect(dueCreditReminder(openai, "2026-12-31")).toBe("2026-12-24");
    expect(dueCreditReminder(openai, "2027-01-01")).toBeNull();
  });

  it("emails the founder on 2026-12-01 and 2026-12-24, once each", async () => {
    let now = new Date("2026-11-30T23:00:00Z");
    const { monitor, mail } = monitorWith({ now: () => now });
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(0);

    now = new Date("2026-12-01T09:00:00Z");
    await monitor.observe(entry());
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Curvi: the OpenAI credits expire on 2026-12-31");
    expect(mail.sent[0].text).toContain("in 30 days");

    now = new Date("2026-12-02T09:00:00Z");
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(1);

    now = new Date("2026-12-24T09:00:00Z");
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].text).toContain("in 7 days");

    now = new Date("2027-01-02T09:00:00Z");
    await monitor.observe(entry());
    expect(mail.sent).toHaveLength(2);
  });

  it("writes the reminder in plain words", () => {
    const { text } = composeCreditExpiryReminder(openai, "2026-12-30");
    expect(text).toContain("in 1 day.");
    expect(text).not.toMatch(/ - | – | — |->|→/);
  });
});

describe("with the database (PgCapStore)", () => {
  let created: Awaited<ReturnType<typeof createTestDb>>;
  let store: PgCapStore;

  beforeAll(async () => {
    created = await createTestDb();
    store = new PgCapStore(created.db as unknown as Db);
  });

  afterAll(async () => {
    await created.client.close();
  });

  it("adds many counters in one statement, summing repeated keys, and lists them by prefix", async () => {
    const totals = await store.addMany([
      { key: "llm|test|a", delta: 5 },
      { key: "llm|test|b", delta: 0 },
      { key: "llm|test|a", delta: 2 },
    ]);
    expect(totals.get("llm|test|a")).toBe(7);
    expect(totals.get("llm|test|b")).toBe(0);
    expect((await store.addMany([{ key: "llm|test|a", delta: 3 }])).get("llm|test|a")).toBe(10);
    expect(await store.addMany([])).toEqual(new Map());
    await store.add("llm_other", 1);
    // An underscore in the prefix is matched literally.
    expect([...(await store.listByPrefix("llm|test|")).entries()]).toEqual([
      ["llm|test|a", 10],
      ["llm|test|b", 0],
    ]);
    expect((await store.listByPrefix("llm_")).has("llm|test|a")).toBe(false);
  });

  it("shares counters and alert dedupe across monitors and records the events rows", async () => {
    const mail = mailer();
    const log = quietLog();
    const build = () =>
      new LlmMonitor({
        store,
        alerts: new LlmAlertNotifier({
          db: created.db as unknown as Db,
          dedupe: store,
          readEnv: mail.readEnv,
          fetchImpl: mail.fetchImpl,
          log,
        }),
        log,
        now: () => AT,
      });
    // Two task runs of the same hour, each with its own monitor.
    const runA = build();
    const runB = build();
    for (let i = 0; i < 10; i += 1) await runA.observe(entry({ jobId: "job-db" }));
    for (let i = 0; i < 8; i += 1) await runB.observe(entry({ jobId: "job-db" }));
    await runA.observe(entry({ provider: SONNET, jobId: "job-db" }));
    await runB.observe(entry({ provider: SONNET, jobId: "job-db" }));
    await runA.observe(entry({ provider: SONNET, jobId: "job-db" }));
    expect(mail.sent).toHaveLength(1);

    const report = await llmSpendReport(store, ["2026-10-01"]);
    expect(report.byFamily.openai.calls).toBe(18);
    expect(report.byFamily.anthropic.calls).toBe(3);
    expect(await packLlmSpend(store, "job-db")).toEqual({ openai: 1_800, anthropic: 300 });

    await runB.onProviderQuota({ provider: LUNA, task: "qc_judge", message: "credit_balance_exhausted" });
    const rows = await created.db
      .select({ name: events.name, props: events.props })
      .from(events)
      .where(eq(events.name, LLM_ALERT_EVENT_NAMES.llm_fallback));
    expect(rows).toHaveLength(1);
    expect(rows[0].props).toMatchObject({ hour: "2026-10-01T14", primaryCalls: 20, fallbackCalls: 2 });
    const quotaRows = await created.db.select().from(events).where(eq(events.name, LLM_ALERT_EVENT_NAMES.llm_quota));
    expect(quotaRows).toHaveLength(1);
  });
});
