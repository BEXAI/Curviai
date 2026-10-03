import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOWN_CODES, SEVERITY_TABLE, classify, downCodes, severityOf, severityRuleFor } from "./health-status";
import { preflightWarnings, providerQuotaWarnings, stageBreakerWarnings } from "./service-health";

const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every lib source that can emit a health warning: llm-spend.ts and any
 * non test file named *health* (health-status.ts itself holds the
 * patterns, not codes). */
function warningSources(dir = LIB_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...warningSources(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      entry.name !== "health-status.ts" &&
      (entry.name.includes("health") || entry.name === "llm-spend.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/** The codes a source writes as `code: "..."` or `code: \`...\``, with each
 * template placeholder replaced by a sample value. */
function emittedCodes(source: string): string[] {
  const codes: string[] = [];
  for (const match of source.matchAll(/\bcode:\s*(["'`])((?:(?!\1)[^\n])+)\1/g)) {
    codes.push(match[2].replace(/\$\{[^}]*\}/g, "sample"));
  }
  return codes;
}

// docs/phases/PHASE_20.md P20-15: the severity table and classify.

describe("severityOf", () => {
  it("uses the exact retirement info codes at 15 to 30 days without downgrading other warnings", () => {
    const notice = "llm_model_retiring:fixture-model";
    expect(severityOf(notice, { retirementInfoCodes: [notice] })).toBe("info");
    expect(severityOf(notice, { retirementInfoCodes: [] })).toBe("degraded");
    expect(severityOf("database_failed", { retirementInfoCodes: ["database_failed"] })).toBe("down");
    expect(classify([notice], { retirementInfoCodes: [notice] })).toEqual({ status: "ok", degradedBy: [] });
    expect(classify([notice])).toEqual({ status: "degraded", degradedBy: [notice] });
  });
  it.each([
    ["database_failed", "down"],
    ["schema_behind", "down"],
    ["draining", "down"],
    ["packs_paused:quota", "degraded"],
    ["scenes_paused", "degraded"],
    ["maintenance", "degraded"],
    ["provider_quota:fal-birefnet", "degraded"],
    ["breaker_open:cutout", "degraded"],
    ["no_cutout_provider", "degraded"],
    ["no_llm_provider", "degraded"],
    ["storage_not_configured", "degraded"],
    ["fal_balance_low", "degraded"],
    ["cron_never_ran:stale-jobs", "degraded"],
    ["cron_overdue:stale-jobs", "degraded"],
    ["cron_check_failed", "degraded"],
    ["memory_high", "degraded"],
    ["db_size_high", "degraded"],
    ["llm_credits_expired:openai", "degraded"],
    ["llm_model_retiring:claude-haiku-4-5", "degraded"],
    ["turnstile_secret_missing", "degraded"],
    ["config_check_failed", "degraded"],
    ["recipe_drift", "info"],
    ["recipe_check_failed", "info"],
    ["fal_admin_key_missing", "info"],
    ["llm_credits_expiring:openai", "info"],
    ["shot_concurrency_invalid", "info"],
    ["trigger_secret_ignored", "info"],
  ])("%s is %s", (code, severity) => {
    expect(severityOf(code, { checkoutOpen: true })).toBe(severity);
  });

  it("counts a code with no row as degraded", () => {
    expect(severityRuleFor("something_new")).toBeNull();
    expect(severityOf("something_new")).toBe("degraded");
  });

  it("matches a pattern only as a whole code", () => {
    expect(severityRuleFor("no_cutout_provider_extra")).toBeNull();
    expect(severityRuleFor("xstorage_not_configured")).toBeNull();
    expect(severityRuleFor("cron_overdue")).toBeNull();
  });

  it("keeps the webhook and portal warnings at info until checkout is open", () => {
    for (const code of [
      "stripe_webhook_quiet",
      "stripe_webhook_endpoint_mismatch",
      "stripe_portal_upgrade_config_missing",
      "legal_facts_pending",
    ]) {
      expect(severityOf(code)).toBe("info");
      expect(severityOf(code, { checkoutOpen: false, billingLive: true })).toBe("info");
      expect(severityOf(code, { checkoutOpen: true, billingLive: true })).toBe("degraded");
    }
  });

  it("rates a readiness problem degraded once billing is meant to be live, though it keeps checkout closed (law and copy review major 5)", () => {
    // A readiness problem always closes checkout, so checkoutOpen is never
    // true alongside it; what counts is whether sales should be running.
    for (const code of [
      "stripe_secret_key_missing",
      "stripe_webhook_secret_missing",
      "stripe_price_missing",
      "stripe_key_mode_mismatch",
      "billing_email_not_configured",
    ]) {
      expect(severityOf(code, { checkoutOpen: false })).toBe("info");
      expect(severityOf(code, { checkoutOpen: false, billingLive: true })).toBe("degraded");
    }
    expect(classify(["stripe_webhook_secret_missing"], { checkoutOpen: false, billingLive: true })).toEqual({
      status: "degraded",
      degradedBy: ["stripe_webhook_secret_missing"],
    });
    expect(classify(["stripe_webhook_secret_missing"], { checkoutOpen: false }).status).toBe("ok");
    expect(severityOf("billing_email_failing")).toBe("degraded");
  });

  it("lists every table code once", () => {
    const codes = SEVERITY_TABLE.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has a row for every code config-health and the other health sources can emit", () => {
    const sources = warningSources();
    expect(sources.map((path) => path.slice(LIB_DIR.length)).sort()).toEqual(
      expect.arrayContaining(["config-health.ts", "llm-spend.ts"]),
    );
    const codes = sources.flatMap((path) => emittedCodes(readFileSync(path, "utf8")));
    // The scan finds the codes it should (a broken regex finds none).
    expect(codes).toEqual(expect.arrayContaining(["storage_not_configured", "db_size_high", "cron_overdue:sample"]));
    expect(codes.filter((code) => severityRuleFor(code) === null)).toEqual([]);
  });

  it("has a row for every code the health route adds itself", async () => {
    const quota = await providerQuotaWarnings(["fal-birefnet"], { openReason: async () => "quota" });
    const stages = await stageBreakerWarnings([{ name: "fal-birefnet", stages: ["cutout"], configured: true }], {
      isOpen: async () => true,
    });
    const codes = [
      ...quota,
      ...stages.codes,
      ...preflightWarnings({ verdict: "packs_paused", cause: "quota" }),
      ...preflightWarnings({ verdict: "packs_paused", cause: "failures" }),
      ...preflightWarnings({ verdict: "scenes_paused", cause: "failures" }),
      "config_check_failed",
      ...downCodes({ database: "failed", schema: "behind", packRunner: "draining" }),
    ];
    expect(codes.length).toBe(9);
    expect(codes.filter((code) => severityRuleFor(code) === null)).toEqual([]);
  });

  it("counts a quota trip as degraded only when it pauses a stage", () => {
    // Without the stage context the rule keeps its main severity.
    expect(severityOf("provider_quota:fal-birefnet")).toBe("degraded");
    expect(severityOf("provider_quota:fal-birefnet", { pausedProviders: ["fal-birefnet", "fal-birefnet-backup"] })).toBe(
      "degraded",
    );
    // The backup account still serves the stage.
    expect(severityOf("provider_quota:fal-birefnet", { pausedProviders: [] })).toBe("info");
    expect(severityOf("provider_quota:openai:gpt-6-luna", { pausedProviders: ["openai:gpt-6-luna"] })).toBe("degraded");
    expect(severityOf("provider_quota:openai:gpt-6-luna", { pausedProviders: ["openai:other"] })).toBe("info");
  });
});

describe("classify", () => {
  it("is degraded during a quota trip that pauses packs, and ok when a backup still serves", () => {
    expect(
      classify(["provider_quota:fal-birefnet", "breaker_open:cutout", "packs_paused:quota"], {
        pausedProviders: ["fal-birefnet"],
      }),
    ).toEqual({ status: "degraded", degradedBy: ["provider_quota:fal-birefnet", "breaker_open:cutout", "packs_paused:quota"] });
    expect(classify(["provider_quota:fal-birefnet"], { pausedProviders: [] })).toEqual({ status: "ok", degradedBy: [] });
  });

  it("is ok with no codes or only info codes", () => {
    expect(classify([])).toEqual({ status: "ok", degradedBy: [] });
    expect(classify(["recipe_drift", "stripe_webhook_quiet"])).toEqual({ status: "ok", degradedBy: [] });
  });

  it("is degraded for any degraded or unknown code, listing them in order", () => {
    expect(classify(["recipe_drift", "packs_paused:quota", "brand_new_code", "packs_paused:quota"])).toEqual({
      status: "degraded",
      degradedBy: ["packs_paused:quota", "brand_new_code"],
    });
  });

  it("is down when a down code is present, listing down codes first", () => {
    expect(classify(["memory_high", DOWN_CODES.database], { checkoutOpen: true })).toEqual({
      status: "down",
      degradedBy: ["database_failed", "memory_high"],
    });
  });
});

describe("downCodes", () => {
  it("maps today's ok false checks to their codes", () => {
    expect(downCodes({ database: "ok", schema: "current", packRunner: "accepting" })).toEqual([]);
    expect(downCodes({ database: "failed", schema: "behind", packRunner: "draining" })).toEqual([
      "database_failed",
      "schema_behind",
      "draining",
    ]);
    expect(downCodes({ database: "skipped", schema: "unknown", packRunner: "idle" })).toEqual([]);
  });
});
