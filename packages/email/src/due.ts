/**
 * Which lifecycle email each person is due (docs/phases/PHASE_18.md P18-07):
 * a pure function of the facts the cron reads (funnel events, jobs, the
 * ledger, leads, pauses, the send log and the suppression list) and the
 * seeded schedule (packages/pipeline/src/seed/growth.ts lifecycleSchedule).
 *
 * | Template | Trigger | Kind | Stops when |
 * | welcome | signup_confirmed | transactional | sent once |
 * | first_pack_nudge_1 | 1 day after confirmation, no pack started, the free grant paid | marketing | a pack starts; held while waitlisted |
 * | first_pack_nudge_2 | 3 days after, still no pack, a day after nudge 1 | marketing | as above |
 * | pack_ready | pack_done with a passed file | transactional | once per job |
 * | feedback_ask | 2 days after the first pack done, no answer | marketing | answered |
 * | out_of_credits | balance below the next pack after a pack, free or Starter | marketing | once per 30 days; a purchase |
 * | win_back | 21 days after the last pack, no pack since | marketing | once ever; a new pack |
 * | packs_back | acquisition reopened | transactional to accounts, marketing to waitlist leads | once per pause, to waitlist leads and signups of the pause with no pack |
 * | lead_results | a lead from a tool who ticked the consent box | marketing | once per lead and tool |
 * | lead_tip | 3 days after consent, no signup | marketing | signup |
 * | lead_offer | 10 days after consent, no signup | marketing | signup |
 *
 * Every email has a due time and a lateness limit, so switching email on
 * never mails people whose moment has passed; for held emails the hours
 * packs were paused do not count against the limit. A key already sent or
 * suppressed (or failed too often) is never due again, a suppressed
 * address never gets an email of a blocked kind, and a run sends at most
 * one email per person, transactional first, with no marketing email
 * within the seeded spacing of any other email to that person.
 */

import type { EmailSendStatus, EmailSuppressionScope } from "@curvi/db";
import { emailLimits, lifecycleSchedule, type LifecycleSchedule, type LifecycleTemplateKey, type LifecycleTiming } from "@curvi/pipeline/seed";
import { normalizedEmailKey } from "./keys";
import type { EmailTemplate } from "./render";
import { blocks } from "./store";
import {
  feedbackAskEmail,
  firstPackNudge1Email,
  firstPackNudge2Email,
  LEAD_TOOLS,
  leadOfferEmail,
  leadResultsEmail,
  leadTipEmail,
  outOfCreditsEmail,
  packReadyEmail,
  packsBackAccountEmail,
  packsBackLeadEmail,
  referralRewardedEmail,
  welcomeEmail,
  winBackEmail,
  type PackFidelity,
  type PricingFacts,
} from "./templates";

const HOUR_MS = 60 * 60 * 1000;

/** A signed up workspace and its owner's address. */
export interface AccountFact {
  workspaceId: string;
  email: string;
  plan: string;
  /** funnel.signup_confirmed; null for accounts from before Phase 18. */
  confirmedAt: Date | null;
  /** The first and the newest generation job, whatever became of them. */
  firstPackStartedAt: Date | null;
  lastPackStartedAt: Date | null;
  firstPackDoneAt: Date | null;
  firstPackJobId: string | null;
  lastPackDoneAt: Date | null;
  lastPackJobId: string | null;
  lastPaymentAt: Date | null;
  /** funnel.feedback_submitted (P18-05). */
  feedbackAt: Date | null;
  /** The credit balance now (the ledger sum). */
  balance: number;
  /** The free credits the 0012 signup grant paid this workspace's owner:
   * 0 when withheld (an inbox that already had a grant), null when no grant
   * row exists. */
  signupGrant: number | null;
  /** Signed, same-origin feedback path; absent when signing is unavailable. */
  feedbackPath?: string | null;
}

/** A reward already recorded in the referrer's ledger, still unreversed. */
export interface ReferralRewardFact {
  referralId: string;
  workspaceId: string;
  email: string;
  rewardedAt: Date;
  credits: number;
}

/** One funnel.pack_done row. */
export interface PackDoneFact {
  jobId: string;
  workspaceId: string;
  email: string;
  doneAt: Date;
  productTitle: string | null;
  passed: number;
  needsReview: number;
  fidelity: PackFidelity | null;
}

/** One leads row. */
export interface LeadFact {
  email: string;
  source: string;
  createdAt: Date;
  lastSource: string | null;
  lastSeenAt: Date;
  consentAt: Date | null;
  /** An account exists for the same inbox, or the inbox was paid a signup
   * grant before (a deleted account): the lead offer's free credits would
   * be withheld (migration 0012), so it is never sent. */
  signedUp: boolean;
}

/** A spell of acquisition waitlist (P18-03), from the funnel events. */
export interface PauseFact {
  id: string;
  pausedAt: Date;
  resumedAt: Date | null;
}

/** One email_sends row. */
export interface SentFact {
  dedupeKey: string;
  template: string;
  status: EmailSendStatus;
  attempts: number;
  workspaceId: string | null;
  recipientKey: string;
  at: Date;
}

export interface LifecycleFacts {
  now: Date;
  /** Acquisition is open (P18-03 acquisitionStatus); held emails wait otherwise. */
  acquisitionOpen: boolean;
  pricing: PricingFacts;
  accounts: readonly AccountFact[];
  packsDone: readonly PackDoneFact[];
  referralsRewarded?: readonly ReferralRewardFact[];
  leads: readonly LeadFact[];
  pauses: readonly PauseFact[];
  sent: readonly SentFact[];
  suppressions: ReadonlyMap<string, EmailSuppressionScope>;
}

export interface DueEmail {
  template: EmailTemplate<never>;
  to: string;
  recipientKey: string;
  dedupeKey: string;
  workspaceId: string | null;
  data: unknown;
  dueAt: Date;
}

/** Milliseconds of [from, to] during which acquisition was waitlisted. */
export function pausedMsBetween(pauses: readonly PauseFact[], from: Date, to: Date): number {
  let total = 0;
  for (const pause of pauses) {
    const start = Math.max(pause.pausedAt.getTime(), from.getTime());
    const end = Math.min((pause.resumedAt ?? to).getTime(), to.getTime());
    if (end > start) total += end - start;
  }
  return total;
}

function within(at: Date | null | undefined, from: Date, to: Date): boolean {
  return Boolean(at && at.getTime() >= from.getTime() && at.getTime() <= to.getTime());
}

interface Candidate {
  key: LifecycleTemplateKey;
  template: EmailTemplate<never>;
  to: string;
  dedupeKey: string;
  workspaceId: string | null;
  data: unknown;
  /** The trigger time; the email is due afterHours later. */
  trigger: Date;
}

/**
 * Every email due now, in send order. Pure: the same facts always give the
 * same list. The cron applies the per run and per day caps on top.
 */
export function dueEmails(
  facts: LifecycleFacts,
  schedule: LifecycleSchedule = lifecycleSchedule,
  limits: { maxAttempts: number } = emailLimits,
): DueEmail[] {
  const { now } = facts;
  const candidates: Candidate[] = [];
  const add = <D>(key: LifecycleTemplateKey, template: EmailTemplate<D>, c: Omit<Candidate, "key" | "template">) => {
    candidates.push({ key, template: template as unknown as EmailTemplate<never>, ...c });
  };

  const finalKeys = new Set(
    facts.sent
      .filter((s) => s.status === "sent" || s.status === "suppressed" || (s.status === "failed" && s.attempts >= limits.maxAttempts))
      .map((s) => s.dedupeKey),
  );
  const sentAt = new Map(facts.sent.filter((s) => s.status === "sent").map((s) => [s.dedupeKey, s.at]));

  for (const account of facts.accounts) {
    const ws = account.workspaceId;
    if (account.confirmedAt) {
      add("welcome", welcomeEmail, {
        to: account.email,
        dedupeKey: `welcome:${ws}`,
        workspaceId: ws,
        data: { pricing: facts.pricing, freeCredits: Math.max(0, account.signupGrant ?? 0), packsPaused: !facts.acquisitionOpen },
        trigger: account.confirmedAt,
      });
      const noPack = account.firstPackStartedAt === null;
      // "Your free pack is waiting" only to an account the grant paid.
      const granted = (account.signupGrant ?? 0) > 0;
      if (noPack && granted && schedule.nudgePlans.includes(account.plan)) {
        add("first_pack_nudge_1", firstPackNudge1Email, {
          to: account.email,
          dedupeKey: `first_pack_nudge_1:${ws}`,
          workspaceId: ws,
          data: {},
          trigger: account.confirmedAt,
        });
        const nudge1At = sentAt.get(`first_pack_nudge_1:${ws}`);
        if (nudge1At && now.getTime() - nudge1At.getTime() >= schedule.nudgeGapHours * HOUR_MS) {
          add("first_pack_nudge_2", firstPackNudge2Email, {
            to: account.email,
            dedupeKey: `first_pack_nudge_2:${ws}`,
            workspaceId: ws,
            data: {},
            trigger: account.confirmedAt,
          });
        }
      }
      // Packs back to a signup made while packs were paused, who made no pack before they came back.
      for (const pause of facts.pauses) {
        if (!pause.resumedAt || !within(account.confirmedAt, pause.pausedAt, pause.resumedAt)) continue;
        if (account.firstPackStartedAt && account.firstPackStartedAt.getTime() <= pause.resumedAt.getTime()) continue;
        const key = normalizedEmailKey(account.email);
        if (!key) continue;
        add("packs_back", packsBackAccountEmail, {
          to: account.email,
          dedupeKey: `packs_back:${pause.id}:${key}`,
          workspaceId: ws,
          data: {},
          trigger: pause.resumedAt,
        });
      }
    }

    if (account.firstPackDoneAt && account.firstPackJobId && account.feedbackPath && !account.feedbackAt) {
      add("feedback_ask", feedbackAskEmail, {
        to: account.email,
        dedupeKey: `feedback_ask:${ws}`,
        workspaceId: ws,
        data: { path: account.feedbackPath },
        trigger: account.firstPackDoneAt,
      });
    }

    if (
      account.lastPackDoneAt &&
      account.lastPackJobId &&
      schedule.outOfCreditsPlans.includes(account.plan) &&
      account.balance < facts.pricing.typicalPackCredits &&
      !(account.lastPaymentAt && account.lastPaymentAt.getTime() > account.lastPackDoneAt.getTime())
    ) {
      const repeatFrom = now.getTime() - schedule.outOfCreditsRepeatDays * 24 * HOUR_MS;
      const recent = facts.sent.some(
        (s) => s.template === "out_of_credits" && s.workspaceId === ws && s.status === "sent" && s.at.getTime() >= repeatFrom,
      );
      if (!recent) {
        add("out_of_credits", outOfCreditsEmail, {
          to: account.email,
          dedupeKey: `out_of_credits:${ws}:${account.lastPackJobId}`,
          workspaceId: ws,
          data: { plan: account.plan, balance: account.balance, pricing: facts.pricing },
          trigger: account.lastPackDoneAt,
        });
      }
    }

    if (account.lastPackStartedAt) {
      add("win_back", winBackEmail, {
        to: account.email,
        dedupeKey: `win_back:${ws}`,
        workspaceId: ws,
        data: {},
        trigger: account.lastPackStartedAt,
      });
    }
  }

  for (const reward of facts.referralsRewarded ?? []) {
    if (!Number.isFinite(reward.credits) || reward.credits <= 0) continue;
    add("referral_rewarded", referralRewardedEmail, {
      to: reward.email,
      dedupeKey: `referral_rewarded:${reward.referralId}`,
      workspaceId: reward.workspaceId,
      data: { credits: reward.credits },
      trigger: reward.rewardedAt,
    });
  }

  for (const pack of facts.packsDone) {
    if (pack.passed < 1) continue;
    add("pack_ready", packReadyEmail, {
      to: pack.email,
      dedupeKey: `pack_ready:${pack.jobId}`,
      workspaceId: pack.workspaceId,
      data: {
        jobId: pack.jobId,
        productTitle: pack.productTitle,
        passed: pack.passed,
        needsReview: pack.needsReview,
        fidelity: pack.fidelity,
      },
      trigger: pack.doneAt,
    });
  }

  for (const lead of facts.leads) {
    const key = normalizedEmailKey(lead.email);
    if (!key) continue;
    const captures: [string, Date][] = [[lead.source, lead.createdAt]];
    if (lead.lastSource && lead.lastSource !== lead.source) captures.push([lead.lastSource, lead.lastSeenAt]);
    for (const [source, at] of captures) {
      // Marketing (it promotes the tool again), so only with consent.
      if (lead.consentAt && schedule.leadResultSources.includes(source) && LEAD_TOOLS[source]) {
        add("lead_results", leadResultsEmail, {
          to: lead.email,
          dedupeKey: `lead_results:${key}:${source}`,
          workspaceId: null,
          data: { source },
          trigger: at,
        });
      }
    }
    for (const pause of facts.pauses) {
      if (!pause.resumedAt) continue;
      const waited =
        (lead.source === schedule.waitlistLeadSource && within(lead.createdAt, pause.pausedAt, pause.resumedAt)) ||
        (lead.lastSource === schedule.waitlistLeadSource && within(lead.lastSeenAt, pause.pausedAt, pause.resumedAt));
      if (waited) {
        add("packs_back", packsBackLeadEmail, {
          to: lead.email,
          dedupeKey: `packs_back:${pause.id}:${key}`,
          workspaceId: null,
          data: {},
          trigger: pause.resumedAt,
        });
      }
    }
    if (lead.consentAt && !lead.signedUp) {
      add("lead_tip", leadTipEmail, { to: lead.email, dedupeKey: `lead_tip:${key}`, workspaceId: null, data: {}, trigger: lead.consentAt });
      add("lead_offer", leadOfferEmail, {
        to: lead.email,
        dedupeKey: `lead_offer:${key}`,
        workspaceId: null,
        data: { freeCredits: facts.pricing.freeCredits },
        trigger: lead.consentAt,
      });
    }
  }

  // Timing, holds, finished keys and suppression.
  const due: (DueEmail & { kind: string })[] = [];
  for (const c of candidates) {
    const timing: LifecycleTiming = schedule.templates[c.key];
    if (!timing.enabled) continue;
    const dueAt = new Date(c.trigger.getTime() + timing.afterHours * HOUR_MS);
    if (now.getTime() < dueAt.getTime()) continue;
    if (timing.holdWhilePaused && !facts.acquisitionOpen) continue;
    const lateMs =
      now.getTime() - dueAt.getTime() - (timing.holdWhilePaused ? pausedMsBetween(facts.pauses, dueAt, now) : 0);
    if (lateMs > timing.maxLateHours * HOUR_MS) continue;
    if (finalKeys.has(c.dedupeKey)) continue;
    const recipientKey = normalizedEmailKey(c.to);
    if (!recipientKey || blocks(facts.suppressions.get(recipientKey), c.template.kind)) continue;
    due.push({
      template: c.template,
      to: c.to,
      recipientKey,
      dedupeKey: c.dedupeKey,
      workspaceId: c.workspaceId,
      data: c.data,
      dueAt,
      kind: c.template.kind,
    });
  }

  due.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "transactional" ? -1 : 1;
    return a.dueAt.getTime() - b.dueAt.getTime() || a.dedupeKey.localeCompare(b.dedupeKey);
  });

  // One email per person per run, and no marketing email right after another email.
  const lastSentTo = new Map<string, number>();
  for (const s of facts.sent) {
    if (s.status !== "sent") continue;
    lastSentTo.set(s.recipientKey, Math.max(lastSentTo.get(s.recipientKey) ?? 0, s.at.getTime()));
  }
  const spacingMs = schedule.marketingSpacingHours * HOUR_MS;
  const picked = new Set<string>();
  const out: DueEmail[] = [];
  for (const email of due) {
    if (picked.has(email.recipientKey)) continue;
    const last = lastSentTo.get(email.recipientKey);
    if (email.kind === "marketing" && last !== undefined && now.getTime() - last < spacingMs) continue;
    picked.add(email.recipientKey);
    const { kind: _kind, ...rest } = email;
    out.push(rest);
  }
  return out;
}
