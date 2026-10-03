import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as seed from "@curvi/pipeline/seed";
import { rule9Problems } from "@curvi/pipeline";
import * as marketingFacts from "@/lib/marketing-facts";
import * as objectKeys from "@/lib/object-keys";
import { SOURCE_RETENTION_DAYS } from "@/lib/trust/purge";
import { TERMS_VERSION } from "@/lib/trust/terms";
import { LEGAL_FACTS } from "./facts";

// docs/phases/PHASE_20.md P20-23: every number the legal pages state comes
// from its source, and a number whose feature has not shipped stays null so
// the pages say what is true today. The checks below read the seed and the
// modules a later lane adds (P20-07, P20-10, P20-40, P18-12, P20-13) by name,
// so the lane that ships one fails here until it also sets the number in
// facts.ts.

/** A seed export by name, or undefined while no lane has added it. */
function seedExport(name: string): unknown {
  return (seed as Record<string, unknown>)[name];
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("LEGAL_FACTS sources", () => {
  it("reads the source photo window, the terms date and the credit sentence from their sources", () => {
    expect(LEGAL_FACTS.retention.sourcePhotoDays).toBe(SOURCE_RETENTION_DAYS);
    expect(LEGAL_FACTS.termsLastUpdated).toBe(TERMS_VERSION);
    // P20-05: the one credit terms sentence, and its old name is gone.
    const named = marketingFacts as Record<string, unknown>;
    expect(LEGAL_FACTS.creditTermsSentence).toBe(marketingFacts.CREDIT_TERMS_SENTENCE);
    expect(named.UNUSED_CREDITS_SENTENCE).toBeUndefined();
  });

  it("uses the support address and reply time of decision 24", () => {
    expect(LEGAL_FACTS.support).toEqual({ email: "hello@curvi.ai", replyBusinessDays: 2 });
  });

  it("dates every page with a real calendar day", () => {
    for (const day of [LEGAL_FACTS.termsLastUpdated, LEGAL_FACTS.privacyLastUpdated, LEGAL_FACTS.subprocessorsLastUpdated]) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10)).toBe(day);
    }
  });

  it("keeps every sentence plain (rule 9) and sells nothing that is not live", () => {
    for (const text of strings(LEGAL_FACTS)) {
      expect(rule9Problems(text), text).toEqual([]);
      expect(marketingFacts.unqualifiedClaims(text), text).toEqual([]);
    }
  });
});

describe("LEGAL_FACTS numbers follow the features that ship them", () => {
  it("uses the same Phase 21 windows as operational retention", () => {
    expect(LEGAL_FACTS.retention.resolvedCaseDays).toBe(seed.packCasesPolicy.resolvedRetentionDays);
    expect(LEGAL_FACTS.retention.creditBudgetAuditDays).toBe(seed.creditPlanningPolicy.auditRetentionDays);
    expect(LEGAL_FACTS.retention.completionWebhookDays).toBe(seed.webhookPolicy.retentionDays);
  });

  it("states the renewal consent years once P20-07 seeds renewalNotices", () => {
    const years = field(seedExport("renewalNotices"), "consentRecordYears");
    expect(LEGAL_FACTS.retention.consentRecordYears).toBe(typeof years === "number" ? years : null);
  });

  it("states the annual reminder window once P20-07 seeds renewalNotices", () => {
    const window = field(seedExport("renewalNotices"), "annualWindow");
    expect(LEGAL_FACTS.annualRenewalReminderDays).toEqual(Array.isArray(window) ? window : null);
  });

  it("states the longest backup window once P20-10 seeds backup", () => {
    const backup = seedExport("backup");
    const days = [field(backup, "dailyKeepDays"), field(backup, "monthlyKeepDays")].filter(
      (value): value is number => typeof value === "number",
    );
    expect(LEGAL_FACTS.retention.backupMaxDays).toBe(days.length > 0 ? Math.max(...days) : null);
  });

  it("states the temporary file window once P20-40 seeds it and moves the keys under tmp/", () => {
    const days = seedExport("tmpObjectDays");
    expect(LEGAL_FACTS.retention.temporaryFileDays).toBe(typeof days === "number" ? days : null);
    // P20-40 adds isWorkspaceTmpKey with the tmp/ prefix; until then the
    // privacy page must keep saying temporary files stay with the workspace.
    const tmpPrefixShipped = "isWorkspaceTmpKey" in objectKeys;
    expect(LEGAL_FACTS.retention.temporaryFileDays !== null).toBe(tmpPrefixShipped);
  });

  it("states the free preview window once P18-12 seeds freePreview", () => {
    const days = field(seedExport("freePreview"), "retentionDays");
    expect(LEGAL_FACTS.retention.freePreviewDays).toBe(typeof days === "number" ? days : null);
  });

  it("states a log window once error reports go to Sentry (P20-13)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    if ("@sentry/nextjs" in (pkg.dependencies ?? {})) {
      expect(LEGAL_FACTS.retention.logDays).toBeGreaterThan(0);
    } else {
      expect(LEGAL_FACTS.retention.logDays).toBeNull();
    }
  });

  it("leaves the entity and governing law to the founder (decision 9)", () => {
    for (const value of Object.values(LEGAL_FACTS.entity)) {
      expect(value === null || value.trim().length > 0).toBe(true);
    }
  });
});
