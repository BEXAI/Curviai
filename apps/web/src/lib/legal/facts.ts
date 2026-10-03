/**
 * Legal facts in one module (docs/phases/PHASE_20.md P20-23): who we are,
 * how to reach us, the credit and refund terms and every retention number
 * the terms, privacy, subprocessors, help and settings pages state. Numbers
 * come from their sources (code constants and seeds), never typed again
 * here, so a page cannot say something the code does not do.
 *
 * The pages read it through lib/legal/retention.ts (the privacy retention
 * table and the settings sentence) and lib/legal/copy.ts (support reply
 * time, entity and governing law). The lanes that ship a retention feature
 * switch its null to their number: P20-07 (consentRecordYears and
 * annualRenewalReminderDays), P20-10 (backupMaxDays), P20-40
 * (temporaryFileDays), P18-12 (freePreviewDays) and P20-13 or PHASE_19's
 * request logs (logDays). A null is a feature that has not shipped: the page
 * states what is true today instead. facts.test.ts fails when a seed or
 * module for one of them exists and this file still says null, or the
 * numbers differ.
 *
 * A change to what a page says moves that page's "Last updated" date
 * (lib/legal/pages.test.ts records a fingerprint of each page's text).
 *
 * Server side: it reads lib/trust/purge.ts, which imports the database
 * client.
 */

import { backup, creditPlanningPolicy, errorReportRetentionDays, freePreview, packCasesPolicy, renewalNotices, tmpObjectDays, webhookPolicy } from "@curvi/pipeline/seed";
import { CREDIT_TERMS_SENTENCE } from "@/lib/marketing-facts";
import { SOURCE_RETENTION_DAYS } from "@/lib/trust/purge";
import { TERMS_VERSION } from "@/lib/trust/terms";

export interface LegalEntity {
  /** The legal name of the business. Null until the founder supplies it
   * (decision 9); the pages show a marked pending line until then. */
  name: string | null;
  /** One line, as it should print after the name, for example
   * "123 Main Street, Springfield, IL 62701, United States". */
  postalAddress: string | null;
  /** The place whose law governs the terms, as it reads after "the laws
   * of", for example "the State of Delaware, United States". */
  governingLaw: string | null;
}

export interface LegalRetention {
  /** Days after a pack last used a source photo before it is deleted. */
  sourcePhotoDays: number;
  /** Days before temporary processing files are deleted (P20-40's tmp/
   * lifecycle rule). Null today: they stay with the workspace until it is
   * deleted. */
  temporaryFileDays: number | null;
  /** The longest time an encrypted database copy is kept (P20-10's monthly
   * copies). Null when no off platform backup runs. */
  backupMaxDays: number | null;
  /** Years the renewal consent and billing email records are kept
   * (P20-07's renewalNotices.consentRecordYears). Null until P20-07. */
  consentRecordYears: number | null;
  /** Or this many years after the plan ends, whichever is later
   * (renewalNotices.consentRecordYearsAfterPlanEnds). */
  consentRecordYearsAfterPlanEnds: number | null;
  /** Days a free preview's photos are kept without an account (P18-12's
   * anon/ lifecycle). Null until P18-12 ships. */
  freePreviewDays: number | null;
  /** Days request logs and error reports are kept: PHASE_19's request logs
   * (decision 10, up to 30 days on every Render plan) and the Sentry
   * lookback of decision 13 (seed errorReportRetentionDays), one number.
   * The privacy policy's assistant section reads it too
   * (app/(marketing)/privacy/privacy-copy.ts). Null when no such statement
   * is made. */
  logDays: number | null;
  /** Phase 21 resolved public case history and related operator notes. */
  resolvedCaseDays: number | null;
  /** Owner budget change history; current settings stay with the workspace. */
  creditBudgetAuditDays: number | null;
  /** Completion event and delivery metadata, without response bodies. */
  completionWebhookDays: number | null;
}

export interface LegalFacts {
  entity: LegalEntity;
  support: {
    email: string;
    /** Business days to a first reply (decision 24). */
    replyBusinessDays: number;
  };
  /** The one sentence about how long credits last (P20-05). */
  creditTermsSentence: string;
  /** What the terms say about refunds today (P18 decision 14's money back
   * promise replaces it once the legal review approves it). */
  refundPolicy: string;
  retention: LegalRetention;
  /** The days before an annual renewal within which the reminder email goes
   * out, [earliest, latest] (P20-07's renewalNotices.annualWindow). Null
   * until P20-07: the terms make no reminder promise. */
  annualRenewalReminderDays: readonly [number, number] | null;
  /** Days of email notice before a material change to the terms applies. */
  termsChangeNoticeDays: number;
  /** The "Last updated" dates, YYYY-MM-DD. */
  termsLastUpdated: string;
  privacyLastUpdated: string;
  subprocessorsLastUpdated: string;
}

/** Today's legal facts. */
export const LEGAL_FACTS: LegalFacts = {
  // Public name and address supplied by the founder on 2026-10-02.
  // Incorporation in Delaware does not choose the law governing the terms.
  entity: {
    name: "AIManagement Inc.",
    postalAddress: "131 Continental Drive, Suite 305, Newark New Castle, DE 19713",
    governingLaw: null,
  },
  support: { email: "hello@curvi.ai", replyBusinessDays: 2 },
  creditTermsSentence: CREDIT_TERMS_SENTENCE,
  refundPolicy: "Fees are billed in advance and are non refundable except where the law requires otherwise.",
  retention: {
    sourcePhotoDays: SOURCE_RETENTION_DAYS,
    temporaryFileDays: tmpObjectDays,
    // P20-10: the monthly copies outlive the daily ones.
    backupMaxDays: Math.max(backup.dailyKeepDays, backup.monthlyKeepDays),
    // P20-07: renewal consent records (billing_consents) and billing email
    // records are kept for the seeded years.
    consentRecordYears: renewalNotices.consentRecordYears,
    consentRecordYearsAfterPlanEnds: renewalNotices.consentRecordYearsAfterPlanEnds,
    // P18-12: the free preview's anon/ files and claim (the R2 rule matches).
    freePreviewDays: freePreview.retentionDays,
    // P20-13 and PHASE_19: error reports go to Sentry (the Developer plan's
    // lookback) and request logs stay on Render for up to the same 30 days.
    logDays: errorReportRetentionDays,
    resolvedCaseDays: packCasesPolicy.resolvedRetentionDays,
    creditBudgetAuditDays: creditPlanningPolicy.auditRetentionDays,
    completionWebhookDays: webhookPolicy.retentionDays,
  },
  // P20-07: the yearly plan reminder window the renewal terms state.
  annualRenewalReminderDays: renewalNotices.annualWindow,
  termsChangeNoticeDays: 30,
  termsLastUpdated: TERMS_VERSION,
  privacyLastUpdated: "2026-10-02",
  subprocessorsLastUpdated: "2026-10-02",
};
