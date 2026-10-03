import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { SOURCE_RETENTION_DAYS } from "@/lib/trust/purge";
import { LEGAL_FACTS, type LegalFacts } from "./facts";
import { RETENTION_RIGHTS, retentionRows, uploadRetentionSummary, type RetentionRowKey } from "./retention";

// docs/phases/PHASE_20.md P20-23: the privacy retention table and the
// settings sentence render every number from the facts, and a row whose
// feature has not shipped says what is true today.

const TODAY: LegalFacts = {
  ...LEGAL_FACTS,
  retention: {
    sourcePhotoDays: SOURCE_RETENTION_DAYS,
    temporaryFileDays: null,
    backupMaxDays: null,
    consentRecordYears: null,
    consentRecordYearsAfterPlanEnds: null,
    freePreviewDays: null,
    logDays: null,
    resolvedCaseDays: null,
    creditBudgetAuditDays: null,
    completionWebhookDays: null,
  },
};

// Distinct numbers, so each can be found in exactly its own row.
const SHIPPED: LegalFacts = {
  ...LEGAL_FACTS,
  retention: {
    sourcePhotoDays: 31,
    temporaryFileDays: 7,
    backupMaxDays: 180,
    consentRecordYears: 3,
    consentRecordYearsAfterPlanEnds: 1,
    freePreviewDays: 2,
    logDays: 29,
    resolvedCaseDays: 181,
    creditBudgetAuditDays: 366,
    completionWebhookDays: 32,
  },
};

function row(facts: LegalFacts, key: RetentionRowKey) {
  return retentionRows(facts).find((candidate) => candidate.key === key);
}

describe("retentionRows", () => {
  it("states today's source window from lib/trust/purge.ts", () => {
    expect(row(LEGAL_FACTS, "source_uploads")?.howLong).toContain(
      `once they are ${SOURCE_RETENTION_DAYS} days old and no pack from the last ${SOURCE_RETENTION_DAYS} days used them`,
    );
  });

  it("says only what is true today while the later features have not shipped", () => {
    expect(retentionRows(TODAY).map((r) => r.key)).toEqual([
      "source_uploads",
      "pack_files",
      "temporary_files",
      "assistant_connections",
      "account",
      "backups",
    ]);
    expect(row(TODAY, "temporary_files")?.howLong).toBe(
      "We keep them with your workspace until you delete your account.",
    );
    expect(row(TODAY, "backups")?.howLong).not.toMatch(/\d/);
  });

  it("renders each shipped number in its own row", () => {
    const rows = retentionRows(SHIPPED);
    expect(rows.map((r) => r.key)).toEqual([
      "source_uploads",
      "pack_files",
      "temporary_files",
      "free_preview",
      "assistant_connections",
      "resolution_cases",
      "credit_budgets",
      "completion_webhooks",
      "account",
      "renewal_consent",
      "billing_emails",
      "backups",
      "logs",
    ]);
    expect(row(SHIPPED, "source_uploads")?.howLong).toContain("31 days old");
    expect(row(SHIPPED, "temporary_files")?.howLong).toBe("We delete them within about 7 days.");
    expect(row(SHIPPED, "free_preview")?.howLong).toBe("We delete them within 2 days.");
    // PHASE_19 P19-23: kept after a disconnect, deleted with the account.
    expect(row(SHIPPED, "assistant_connections")?.howLong).toContain(
      "until you close your account, including after you disconnect",
    );
    expect(row(SHIPPED, "backups")?.howLong).toBe(
      "We keep them for up to 180 days, so data you delete can remain in them until then.",
    );
    expect(row(SHIPPED, "logs")?.howLong).toBe("We keep them for up to 29 days.");
    expect(row(SHIPPED, "resolution_cases")?.howLong).toContain("after 181 days");
    expect(row(SHIPPED, "resolution_cases")?.howLong).toContain("does not extend the lifetime of your original photos");
    expect(row(SHIPPED, "credit_budgets")?.howLong).toContain("change history for 366 days");
    expect(row(SHIPPED, "completion_webhooks")?.howLong).toContain("after 32 days");
    expect(row(SHIPPED, "completion_webhooks")?.howLong).toContain("do not store receiver response bodies");
  });

  it("keeps the renewal consent and billing email rows for consentRecordYears, past account deletion", () => {
    for (const key of ["renewal_consent", "billing_emails"] as const) {
      const kept = row(SHIPPED, key)?.howLong ?? "";
      expect(kept).toContain("for 3 years");
      expect(kept).toContain("including after you delete your account");
    }
    // California: the longer of three years and one year after the plan
    // ends (law and copy review 9).
    expect(row(SHIPPED, "renewal_consent")?.howLong).toBe(
      "We keep this record for 3 years after you agree, or 1 year after your plan ends if that is later, including after you delete your account, because renewal laws require it.",
    );
    expect(
      row({ ...SHIPPED, retention: { ...SHIPPED.retention, consentRecordYears: 1, consentRecordYearsAfterPlanEnds: null } }, "renewal_consent")?.howLong,
    ).toContain("for 1 year,");
    // The account row points at them.
    expect(row(SHIPPED, "account")?.howLong).toContain("The rows below say what we keep after that.");
  });

  it("follows the copy rules and sells nothing that is not live", () => {
    for (const facts of [TODAY, SHIPPED]) {
      for (const r of retentionRows(facts)) {
        for (const text of [r.what, r.howLong]) {
          expect(rule9Problems(text), text).toEqual([]);
          expect(unqualifiedClaims(text), text).toEqual([]);
        }
      }
    }
    expect(rule9Problems(RETENTION_RIGHTS)).toEqual([]);
  });
});

describe("uploadRetentionSummary", () => {
  it("is the settings sentence, with the same window as the privacy table", () => {
    expect(uploadRetentionSummary(LEGAL_FACTS)).toBe(
      `We delete original uploads once they are ${SOURCE_RETENTION_DAYS} days old and no pack from the last ${SOURCE_RETENTION_DAYS} days used them. Finished pack files stay while your account is open.`,
    );
    expect(uploadRetentionSummary(SHIPPED)).toContain("31 days old");
    expect(rule9Problems(uploadRetentionSummary(LEGAL_FACTS))).toEqual([]);
  });
});
