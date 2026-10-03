/**
 * How long Curvi keeps each kind of data (docs/phases/PHASE_20.md P20-23):
 * the rows of the privacy policy's retention table and the sentence the
 * settings page shows, every number rendered from lib/legal/facts.ts.
 *
 * A row whose feature has not shipped says what is true today: until
 * P20-40's tmp/ lifecycle rule exists, temporary files stay with the
 * workspace; the free preview row appears once P18-12 ships (it has); the
 * assistant connection row comes from PHASE_19 P19-23; the renewal
 * consent and billing email rows once P20-07 sets consentRecordYears; the
 * log row once a log retention number is set.
 *
 * Pure: takes the facts as an argument.
 */

import { countOf } from "./copy";
import type { LegalFacts } from "./facts";

export type RetentionRowKey =
  | "source_uploads"
  | "pack_files"
  | "temporary_files"
  | "free_preview"
  | "assistant_connections"
  | "resolution_cases"
  | "credit_budgets"
  | "completion_webhooks"
  | "account"
  | "renewal_consent"
  | "billing_emails"
  | "backups"
  | "logs";

export interface RetentionRow {
  key: RetentionRowKey;
  /** The kind of data, as the table's first column says it. */
  what: string;
  /** How long it is kept, as whole sentences. */
  howLong: string;
}

/** "once they are 30 days old and no pack from the last 30 days used them". */
function sourceRule(days: number): string {
  return `once they are ${countOf(days, "day")} old and no pack from the last ${countOf(days, "day")} used them`;
}

/** The privacy policy's retention table, in the order it prints. */
export function retentionRows(facts: LegalFacts): RetentionRow[] {
  const r = facts.retention;
  const rows: RetentionRow[] = [
    {
      key: "source_uploads",
      what: "Original files you upload, such as product photos",
      howLong: `We delete them ${sourceRule(r.sourcePhotoDays)}. A photo shown on a share page stays until you take that page down.`,
    },
    {
      key: "pack_files",
      what: "Your pack files",
      howLong: "We keep them while your account is open.",
    },
    {
      key: "temporary_files",
      what: "Temporary processing files, such as cutouts we reuse",
      howLong:
        r.temporaryFileDays === null
          ? "We keep them with your workspace until you delete your account."
          : `We delete them within about ${countOf(r.temporaryFileDays, "day")}.`,
    },
  ];
  if (r.freePreviewDays !== null) {
    rows.push({
      key: "free_preview",
      what: "Photos you try in the free preview without an account",
      howLong: `We delete them within ${countOf(r.freePreviewDays, "day")}.`,
    });
  }
  // PHASE_19 P19-23: a disconnect marks the connection revoked and keeps
  // the record, so a disconnected assistant cannot come back silently.
  rows.push({
    key: "assistant_connections",
    what: "Records of the assistants you connect, such as ChatGPT",
    howLong:
      "We keep them until you close your account, including after you disconnect, so a disconnected assistant cannot come back without asking you.",
  });
  if (r.resolvedCaseDays !== null) {
    rows.push({
      key: "resolution_cases",
      what: "Pack help reports, replies and related internal notes",
      howLong: `We keep open reports while your workspace exists. We delete resolved reports and their history after ${countOf(r.resolvedCaseDays, "day")}, or when the workspace is deleted. A report does not extend the lifetime of your original photos.`,
    });
  }
  if (r.creditBudgetAuditDays !== null) {
    rows.push({
      key: "credit_budgets",
      what: "Optional credit budget settings and changes",
      howLong: `We keep the current setting while your workspace exists and its change history for ${countOf(r.creditBudgetAuditDays, "day")}. Deleting the workspace deletes both.`,
    });
  }
  if (r.completionWebhookDays !== null) {
    rows.push({
      key: "completion_webhooks",
      what: "Completion webhook settings and delivery records",
      howLong: `We keep endpoint settings until you remove them or delete the workspace. We delete completion events and delivery records after ${countOf(r.completionWebhookDays, "day")}. We do not store receiver response bodies.`,
    });
  }
  rows.push({
    key: "account",
    what: "Your account and workspace",
    howLong:
      "When you delete your account, we delete your workspace with its products, photos, packs and files straight away. The rows below say what we keep after that.",
  });
  if (r.consentRecordYears !== null) {
    const afterEnd =
      r.consentRecordYearsAfterPlanEnds !== null
        ? ` after you agree, or ${countOf(r.consentRecordYearsAfterPlanEnds, "year")} after your plan ends if that is later`
        : "";
    const kept = `We keep this record for ${countOf(r.consentRecordYears, "year")}${afterEnd}, including after you delete your account, because renewal laws require it.`;
    rows.push(
      { key: "renewal_consent", what: "The renewal terms you agreed to when you bought a plan", howLong: kept },
      { key: "billing_emails", what: "Records of the billing emails we sent you", howLong: kept },
    );
  }
  rows.push({
    key: "backups",
    what: "Encrypted copies of our database",
    howLong:
      r.backupMaxDays === null
        ? "We make them before changes to our database and keep them for recovery, so data you delete can remain in them until those copies are deleted."
        : `We keep them for up to ${countOf(r.backupMaxDays, "day")}, so data you delete can remain in them until then.`,
  });
  if (r.logDays !== null) {
    rows.push({
      key: "logs",
      what: "Request logs and error reports",
      howLong: `We keep them for up to ${countOf(r.logDays, "day")}.`,
    });
  }
  return rows;
}

/** The settings page's "How long we keep your uploads" text. */
export function uploadRetentionSummary(facts: LegalFacts): string {
  return `We delete original uploads ${sourceRule(facts.retention.sourcePhotoDays)}. Finished pack files stay while your account is open.`;
}

/** The closing lines under the retention table. */
export const RETENTION_RIGHTS =
  "You can download your data or delete your account at any time in Settings. You can also ask us to delete your data, and we honor applicable privacy laws, including GDPR and CCPA requests.";
