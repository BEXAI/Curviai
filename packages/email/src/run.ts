/**
 * One lifecycle email cron run (docs/phases/PHASE_18.md P18-07), called by
 * POST /api/cron/lifecycle on the stale-jobs command every 10 to 15
 * minutes. In order: the switch must be on and the sender configured (else
 * nothing is read or written); the facts are read and dueEmails picks what
 * is due; marketing email is left for later while its own variables are
 * missing (so no row is written for it); then up to the seeded per run cap,
 * and never past the per UTC day cap counted from email_sends, each email
 * goes through sendEmail one at a time with the seeded spacing. A 429 from
 * Resend ends the run. A dry run reads and selects but sends nothing and
 * writes nothing.
 */

import type { Db } from "@curvi/db";
import { emailLimits, lifecycleSchedule, type LifecycleSchedule } from "@curvi/pipeline/seed";
import { marketingGaps, transactionalGaps, type EmailConfig } from "./config";
import { dueEmails } from "./due";
import { loadLifecycleFacts, type PackFidelityReader, type FeedbackLinkReader } from "./facts";
import type { FetchLike } from "./resend";
import { sendEmail, type SendEmailStatus } from "./send";
import { lifecycleEmailEnabled, sentToday } from "./store";

export interface RunLifecycleDeps {
  db: Pick<Db, "execute" | "insert">;
  config: EmailConfig;
  /** The lifecycle_email_enabled switch; read from platform_settings when unset. */
  enabled?: () => Promise<boolean>;
  acquisitionOpen: boolean;
  /** Credits of a default listing pack of stills (the web app's estimate). */
  typicalPackCredits: number;
  /** The one credit terms sentence (CREDIT_TERMS_SENTENCE, P20-05). */
  creditTerms: string;
  fidelity?: PackFidelityReader;
  feedbackLink?: FeedbackLinkReader;
  /** OPS_EMAILS: operator workspaces get no lifecycle email. */
  excludeOwnerEmails?: readonly string[];
  now?: () => Date;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  limits?: typeof emailLimits;
  schedule?: LifecycleSchedule;
  dryRun?: boolean;
  log?: Pick<Console, "warn">;
}

export type TemplateCounts = Record<string, Partial<Record<SendEmailStatus | "due" | "waiting", number>>>;

export interface LifecycleRunReport {
  status: "switched_off" | "not_configured" | "ran" | "dry_run";
  /** Emails due this run, before the caps. */
  due: number;
  /** Resend calls made. */
  attempted: number;
  sent: number;
  byTemplate: TemplateCounts;
  /** Why the run stopped early, if it did. */
  stoppedBy?: "run_cap" | "day_cap" | "rate_limited";
  /** Variables still missing, by name (never values). */
  missing?: string[];
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function bump(counts: TemplateCounts, template: string, status: SendEmailStatus | "due" | "waiting"): void {
  const row = (counts[template] ??= {});
  row[status] = (row[status] ?? 0) + 1;
}

export async function runLifecycle(deps: RunLifecycleDeps): Promise<LifecycleRunReport> {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? emailLimits;
  const schedule = deps.schedule ?? lifecycleSchedule;
  const sleep = deps.sleep ?? sleepDefault;
  const readSwitch = deps.enabled ?? (() => lifecycleEmailEnabled(deps.db));
  const counts: TemplateCounts = {};

  if (!deps.dryRun && !(await readSwitch().catch(() => false))) {
    return { status: "switched_off", due: 0, attempted: 0, sent: 0, byTemplate: counts };
  }
  const senderGaps = transactionalGaps(deps.config);
  if (!deps.dryRun && senderGaps.length > 0) {
    return { status: "not_configured", due: 0, attempted: 0, sent: 0, byTemplate: counts, missing: senderGaps };
  }

  const facts = await loadLifecycleFacts(deps.db, {
    now: now(),
    acquisitionOpen: deps.acquisitionOpen,
    typicalPackCredits: deps.typicalPackCredits,
    creditTerms: deps.creditTerms,
    schedule,
    fidelity: deps.fidelity,
    feedbackLink: deps.feedbackLink,
    excludeOwnerEmails: deps.excludeOwnerEmails,
  });
  const due = dueEmails(facts, schedule, limits);
  for (const email of due) bump(counts, email.template.key, "due");
  if (deps.dryRun) {
    return { status: "dry_run", due: due.length, attempted: 0, sent: 0, byTemplate: counts };
  }

  const missingForMarketing = marketingGaps(deps.config);
  const dayLeft = Math.max(0, limits.perUtcDay - (await sentToday(deps.db, now())));
  const budget = Math.min(limits.perRun, dayLeft);
  const report: LifecycleRunReport = { status: "ran", due: due.length, attempted: 0, sent: 0, byTemplate: counts };
  if (missingForMarketing.length > 0) {
    report.missing = missingForMarketing;
  }

  for (const email of due) {
    if (email.template.kind === "marketing" && missingForMarketing.length > 0) {
      bump(counts, email.template.key, "waiting");
      continue;
    }
    if (report.attempted >= budget) {
      report.stoppedBy = budget === dayLeft && dayLeft < limits.perRun ? "day_cap" : "run_cap";
      break;
    }
    if (report.attempted > 0) {
      await sleep(limits.sendSpacingMs);
    }
    const result = await sendEmail(
      { db: deps.db, config: deps.config, enabled: readSwitch, fetchImpl: deps.fetchImpl, now, limits, log: deps.log },
      { to: email.to, template: email.template, data: email.data as never, dedupeKey: email.dedupeKey, workspaceId: email.workspaceId },
    );
    bump(counts, email.template.key, result.status);
    if (result.status === "sent" || result.status === "failed") {
      report.attempted += result.status === "sent" || result.reason?.startsWith("Resend") ? 1 : 0;
    }
    if (result.status === "sent") {
      report.sent += 1;
    }
    if (result.status === "failed" && result.reason?.startsWith("Resend answered 429")) {
      report.stoppedBy = "rate_limited";
      break;
    }
  }
  return report;
}
