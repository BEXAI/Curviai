import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { billingReconcile } from "@curvi/pipeline/seed";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { platformSettings, type Db } from "@curvi/db";
import { buildConfigReport } from "@/lib/config-health";
import { classify } from "@/lib/health-status";
import { billingHealth, billingHealthWarnings, webhookQuiet } from "./billing-health";
import {
  CHECKOUT_OPENED_KEY,
  readBillingSignals,
  recordBillingEmailResult,
  recordBillingSignal,
  recordReconcileRun,
  WEBHOOK_SUCCESS_KEY,
  type BillingSignals,
} from "./signals";
import { openCheckoutEnv } from "./test-env";

// docs/phases/PHASE_20.md P20-01 and P20-02: the billing warnings in
// GET /api/health.

const NOW = new Date("2026-10-05T12:00:00Z");
const HOUR = 60 * 60_000;
const OPEN = openCheckoutEnv();

function at(msBefore: number): string {
  return new Date(NOW.getTime() - msBefore).toISOString();
}

function signals(partial: Partial<BillingSignals>): BillingSignals {
  return { webhookSuccessAt: null, checkoutOpenedAt: null, reconcile: null, ...partial };
}

function run(partial: { at: string; newestEventAt?: string | null }) {
  return {
    at: partial.at,
    newestEventAt: partial.newestEventAt ?? null,
    applied: 0,
    failed: 0,
    endpoint: null,
    reportedFailures: {},
  };
}

describe("webhookQuiet", () => {
  const grace = 2 * billingReconcile.everyMinutes * 60_000;

  it("is quiet when a checkout opened past the grace and no webhook succeeded since", () => {
    expect(webhookQuiet(signals({ checkoutOpenedAt: at(grace + 60_000) }), NOW)).toBe(true);
    expect(
      webhookQuiet(signals({ checkoutOpenedAt: at(5 * HOUR), webhookSuccessAt: at(6 * HOUR) }), NOW),
    ).toBe(true);
  });

  it("is not quiet without a checkout, inside the grace, or past the window", () => {
    expect(webhookQuiet(signals({}), NOW)).toBe(false);
    expect(webhookQuiet(signals({ checkoutOpenedAt: at(grace - 60_000) }), NOW)).toBe(false);
    const window = billingReconcile.quietWebhookDays * 24 * HOUR;
    expect(webhookQuiet(signals({ checkoutOpenedAt: at(window + HOUR) }), NOW)).toBe(false);
  });

  it("is not quiet once a webhook succeeded after the checkout", () => {
    expect(webhookQuiet(signals({ checkoutOpenedAt: at(5 * HOUR), webhookSuccessAt: at(4 * HOUR) }), NOW)).toBe(false);
  });

  it("is not quiet when a reconcile run after the checkout saw no newer Stripe event (abandoned)", () => {
    expect(
      webhookQuiet(signals({ checkoutOpenedAt: at(5 * HOUR), reconcile: run({ at: at(HOUR), newestEventAt: null }) }), NOW),
    ).toBe(false);
    expect(
      webhookQuiet(
        signals({ checkoutOpenedAt: at(5 * HOUR), reconcile: run({ at: at(HOUR), newestEventAt: at(9 * HOUR) }) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("stays quiet when Stripe made an event after the checkout that no webhook delivered", () => {
    expect(
      webhookQuiet(
        signals({ checkoutOpenedAt: at(5 * HOUR), reconcile: run({ at: at(HOUR), newestEventAt: at(4 * HOUR) }) }),
        NOW,
      ),
    ).toBe(true);
    // A run from before the checkout says nothing about it.
    expect(
      webhookQuiet(signals({ checkoutOpenedAt: at(5 * HOUR), reconcile: run({ at: at(6 * HOUR) }) }), NOW),
    ).toBe(true);
  });
});

describe("billing warnings on a database", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(platformSettings);
  });

  const asDb = () => db as unknown as Db;

  // The legal facts are set in these cases; legal_facts_pending has its own.
  const factsSet = () => [];

  async function warningCodes(env: Record<string, string>): Promise<string[]> {
    const warnings = await billingHealthWarnings({
      readEnv: (name) => env[name],
      db: () => asDb(),
      now: NOW,
      timeoutMs: 1_000,
      pendingLegalFacts: factsSet,
    });
    return warnings.map((warning) => warning.code);
  }

  it("shows the readiness problems: the key alone names the webhook secret", async () => {
    expect(await warningCodes({ STRIPE_SECRET_KEY: "sk_test_alone" })).toEqual([
      "stripe_webhook_secret_missing",
      "stripe_price_missing",
      "billing_email_not_configured",
    ]);
    expect(await warningCodes({})).toEqual([]);
    expect(await warningCodes(OPEN)).toEqual([]);
  });

  it("warns stripe_portal_upgrade_config_missing once checkout is open without an upgrade configuration (P20-06)", async () => {
    const { STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH: _growth, ...withoutGrowth } = OPEN;
    const warnings = await billingHealthWarnings({ readEnv: (name) => withoutGrowth[name], now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet });
    expect(warnings.map((warning) => warning.code)).toEqual(["stripe_portal_upgrade_config_missing"]);
    expect(warnings[0]?.message).toContain("STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH");
    expect(warnings[0]?.message).not.toContain("STRIPE_PORTAL_UPGRADE_CONFIG_STARTER");
    // The yearly and Pro configurations count too (security review 10).
    const { STRIPE_PORTAL_UPGRADE_CONFIG_PRO: _pro, STRIPE_PORTAL_UPGRADE_CONFIG_STARTER_ANNUAL: _starterAnnual, ...withoutPro } = OPEN;
    const proWarnings = await billingHealthWarnings({ readEnv: (name) => withoutPro[name], now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet });
    expect(proWarnings[0]?.message).toContain("STRIPE_PORTAL_UPGRADE_CONFIG_STARTER_ANNUAL, STRIPE_PORTAL_UPGRADE_CONFIG_PRO.");
    // Closed checkout: nobody can subscribe, so nothing to say yet.
    expect(await warningCodes({ STRIPE_SECRET_KEY: "sk_test_alone" })).not.toContain("stripe_portal_upgrade_config_missing");
  });

  it("closes checkout and warns billing_email_not_configured without the sender or the Resend key (law and copy review major 4)", async () => {
    const { BILLING_EMAIL_FROM: _from, ...withoutSender } = OPEN;
    expect(await warningCodes(withoutSender)).toEqual(["billing_email_not_configured"]);
    const { RESEND_API_KEY: _key, ...withoutKey } = OPEN;
    expect(await warningCodes(withoutKey)).toEqual(["billing_email_not_configured"]);
    expect(await warningCodes({})).not.toContain("billing_email_not_configured");
  });

  it("warns billing_email_failing when the last plan email did not go out, until one does", async () => {
    await recordBillingEmailResult(asDb(), { ok: false, kind: "plan_active", invoiceId: "in_403", notice: "Resend answered 403" }, new Date(NOW.getTime() - HOUR));
    const warnings = await billingHealthWarnings({ readEnv: (name) => OPEN[name], db: () => asDb(), now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet });
    expect(warnings.map((warning) => warning.code)).toEqual(["billing_email_failing"]);
    expect(warnings[0]?.message).toContain("in_403");
    expect(warnings[0]?.message).toContain("Resend answered 403");
    await recordBillingEmailResult(asDb(), { ok: true, kind: "plan_active", invoiceId: "in_403" }, NOW);
    expect(await warningCodes(OPEN)).toEqual([]);
  });

  it("warns legal_facts_pending while the terms still leave the entity or governing law for later (law and copy review 13)", async () => {
    const warnings = await billingHealthWarnings({
      readEnv: (name) => OPEN[name],
      now: NOW,
      timeoutMs: 1_000,
      pendingLegalFacts: () => ["entity.name", "entity.governingLaw"],
    });
    expect(warnings.map((warning) => warning.code)).toEqual(["legal_facts_pending"]);
    expect(warnings[0]?.message).toContain("entity.name, entity.governingLaw");
    // Billing off: nothing to say.
    expect(
      await billingHealthWarnings({ readEnv: () => undefined, now: NOW, timeoutMs: 1_000, pendingLegalFacts: () => ["entity.name"] }),
    ).toEqual([]);
  });

  it("calls billing meant to be live with a live key or once a checkout has opened (law and copy review major 5)", async () => {
    const keyOnly = { STRIPE_SECRET_KEY: "sk_test_alone" };
    const before = await billingHealth({ readEnv: (name) => keyOnly[name as keyof typeof keyOnly], db: () => asDb(), now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet });
    expect(before.billingLive).toBe(false);
    await recordBillingSignal(asDb(), CHECKOUT_OPENED_KEY, new Date(NOW.getTime() - 30 * 24 * HOUR));
    const after = await billingHealth({ readEnv: (name) => keyOnly[name as keyof typeof keyOnly], db: () => asDb(), now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet });
    expect(after.billingLive).toBe(true);
    // The webhook secret was removed after launch: health is degraded.
    expect(classify(after.warnings.map((warning) => warning.code), { checkoutOpen: false, billingLive: after.billingLive })).toMatchObject({
      status: "degraded",
      degradedBy: expect.arrayContaining(["stripe_webhook_secret_missing", "billing_email_not_configured"]),
    });
    const live = { STRIPE_SECRET_KEY: "sk_live_x", NEXT_PUBLIC_SITE_URL: "https://curvi.ai" };
    await db.delete(platformSettings);
    expect((await billingHealth({ readEnv: (name) => live[name as keyof typeof live], db: () => asDb(), now: NOW, timeoutMs: 1_000, pendingLegalFacts: factsSet })).billingLive).toBe(true);
  });

  it("reads the signals the routes record and warns stripe_webhook_quiet", async () => {
    await recordBillingSignal(asDb(), CHECKOUT_OPENED_KEY, new Date(NOW.getTime() - 5 * HOUR));
    expect(await warningCodes(OPEN)).toEqual(["stripe_webhook_quiet"]);
    await recordBillingSignal(asDb(), WEBHOOK_SUCCESS_KEY, new Date(NOW.getTime() - 4 * HOUR));
    expect(await warningCodes(OPEN)).toEqual([]);
    const stored = await readBillingSignals(asDb());
    expect(stored.checkoutOpenedAt).toBe(at(5 * HOUR));
    expect(stored.webhookSuccessAt).toBe(at(4 * HOUR));
  });

  it("warns stripe_webhook_endpoint_mismatch from the last reconcile run", async () => {
    await recordReconcileRun(asDb(), {
      ...run({ at: at(HOUR) }),
      endpoint: { ok: false, problems: ["No enabled endpoint listens at https://curvi.ai/api/webhooks/stripe."] },
    });
    const warnings = await billingHealthWarnings({
      readEnv: (name) => OPEN[name],
      db: () => asDb(),
      now: NOW,
      timeoutMs: 1_000,
      pendingLegalFacts: factsSet,
    });
    expect(warnings).toEqual([
      {
        code: "stripe_webhook_endpoint_mismatch",
        message:
          "The Stripe webhook endpoint does not match what this build needs: No enabled endpoint listens at https://curvi.ai/api/webhooks/stripe.",
      },
    ]);
  });

  it("warns stripe_reconcile_behind while the last reconcile run hit its cap", async () => {
    await recordReconcileRun(asDb(), { ...run({ at: at(HOUR) }), truncated: true, resumeFrom: at(2 * HOUR) });
    expect(await warningCodes(OPEN)).toEqual(["stripe_reconcile_behind"]);
    await recordReconcileRun(asDb(), { ...run({ at: at(0) }), truncated: false, resumeFrom: null });
    expect(await warningCodes(OPEN)).toEqual([]);
  });

  it("logs and adds nothing when the signals cannot be read", async () => {
    const logged: string[] = [];
    const warnings = await billingHealthWarnings({
      readEnv: (name) => OPEN[name],
      db: () => ({ execute: async () => Promise.reject(new Error("down")) }),
      now: NOW,
      timeoutMs: 1_000,
      logger: { warn: (...args: unknown[]) => logged.push(args.join(" ")) },
      pendingLegalFacts: factsSet,
    });
    expect(warnings).toEqual([]);
    expect(logged[0]).toContain("billing signals could not be read");
  });

  it("joins the config report /api/health builds", async () => {
    const report = await buildConfigReport({
      mode: "db",
      databaseOk: true,
      db: () => asDb(),
      readEnv: (name) => ({ STRIPE_SECRET_KEY: "sk_test_alone" })[name],
      storageConfigured: true,
      providerTargets: [],
      seedRecipes: [],
      cronJobs: [],
      now: () => NOW,
      rssBytes: () => 1,
      readTextFile: () => null,
      logger: { warn: () => undefined },
    });
    expect(report.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["stripe_webhook_secret_missing", "stripe_price_missing"]),
    );
  });
});
