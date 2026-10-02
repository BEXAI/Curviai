/**
 * Reads the facts dueEmails decides on (docs/phases/PHASE_18.md P18-07)
 * over the owner connection: the server side funnel in events (P18-02:
 * signup_confirmed, pack_done, first_pack_done, payment, feedback_submitted,
 * acquisition_paused and acquisition_resumed), generation_jobs, products,
 * the ledger balance, leads with their consent, the owner's address in
 * auth.users, email_sends and email_suppressions. Everything is bounded by
 * the seeded lookback, so the cron's reads stay small. Addresses stay in
 * memory for the send; nothing here logs them.
 */

import { sql, type EmailSendStatus } from "@curvi/db";
import { lifecycleSchedule, tierByKey, topUps, type LifecycleSchedule } from "@curvi/pipeline/seed";
import type { AccountFact, LeadFact, LifecycleFacts, PackDoneFact, PauseFact, ReferralRewardFact, SentFact } from "./due";
import { normalizedEmailKey } from "./keys";
import { rowsOf, suppressionsOf, type SqlDb } from "./store";
import type { PricingFacts } from "./templates";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The seed numbers the account emails quote, with the web app's one
 * credit terms sentence (P20-05). */
export function pricingFacts(typicalPackCredits: number, creditTerms: string): PricingFacts {
  const starter = tierByKey("starter");
  const smallest = [...topUps].sort((a, b) => a.usd - b.usd)[0];
  return {
    freeCredits: tierByKey("free").creditsOnce,
    typicalPackCredits,
    starter: { monthlyUsd: starter.monthlyUsd, credits: starter.creditsPerMonth },
    topUp: { usd: smallest?.usd ?? 0, credits: smallest?.credits ?? 0 },
    creditTerms,
  };
}

/** Whether auth.users can be read here (Supabase yes; a bare test database no). */
async function hasAuthUsers(db: SqlDb): Promise<boolean> {
  const rows = rowsOf<{ present: boolean }>(await db.execute(sql`select to_regclass('auth.users') is not null as present`));
  return rows[0]?.present === true;
}

async function loadAccounts(db: SqlDb, since: Date, options: LoadFactsOptions): Promise<AccountFact[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      with candidates as (
        select distinct workspace_id from events
        where workspace_id is not null and at >= ${since.toISOString()}::timestamptz
          and name in ('funnel.signup_confirmed', 'funnel.pack_done', 'funnel.pack_started')
        union
        select distinct workspace_id from generation_jobs where created_at >= ${since.toISOString()}::timestamptz
      )
      select w.id as workspace_id, w.plan,
        (select u.email from members m join auth.users u on u.id = m.user_id
          where m.workspace_id = w.id and m.role = 'owner' order by m.created_at, m.user_id limit 1) as email,
        (select m.user_id from members m join auth.users u on u.id = m.user_id
          where m.workspace_id = w.id and m.role = 'owner' order by m.created_at, m.user_id limit 1) as owner_user_id,
        (select min(e.at) from events e where e.workspace_id = w.id and e.name = 'funnel.signup_confirmed') as confirmed_at,
        (select min(j.created_at) from generation_jobs j where j.workspace_id = w.id) as first_started_at,
        (select max(j.created_at) from generation_jobs j where j.workspace_id = w.id) as last_started_at,
        f.at as first_done_at, f.props ->> 'job_id' as first_job_id,
        l.at as last_done_at, l.props ->> 'job_id' as last_job_id,
        (select max(e.at) from events e where e.workspace_id = w.id and e.name = 'funnel.payment') as last_payment_at,
        (select min(e.at) from events e where e.workspace_id = w.id and e.name = 'funnel.feedback_submitted') as feedback_at,
        (select coalesce(sum(c.delta), 0) from credit_ledger c where c.workspace_id = w.id)::float8 as balance,
        (select sum(g.credits) from signup_grants g where g.workspace_id = w.id)::float8 as signup_grant
      from workspaces w
      join candidates cand on cand.workspace_id = w.id
      left join lateral (
        select e.at, e.props from events e
        where e.workspace_id = w.id and e.name = 'funnel.first_pack_done' order by e.at limit 1
      ) f on true
      left join lateral (
        select e.at, e.props from events e
        where e.workspace_id = w.id and e.name = 'funnel.pack_done' order by e.at desc, e.id desc limit 1
      ) l on true
    `),
  );
  const accounts: AccountFact[] = [];
  for (const row of rows) {
    const email = typeof row.email === "string" ? row.email : null;
    if (!email || !normalizedEmailKey(email)) continue;
    accounts.push({
      workspaceId: String(row.workspace_id),
      email,
      plan: typeof row.plan === "string" ? row.plan : "free",
      confirmedAt: date(row.confirmed_at),
      firstPackStartedAt: date(row.first_started_at),
      lastPackStartedAt: date(row.last_started_at),
      firstPackDoneAt: date(row.first_done_at),
      firstPackJobId: typeof row.first_job_id === "string" ? row.first_job_id : null,
      lastPackDoneAt: date(row.last_done_at),
      lastPackJobId: typeof row.last_job_id === "string" ? row.last_job_id : null,
      lastPaymentAt: date(row.last_payment_at),
      feedbackAt: date(row.feedback_at),
      balance: num(row.balance),
      signupGrant: row.signup_grant === null || row.signup_grant === undefined ? null : num(row.signup_grant),
      feedbackPath: typeof row.first_job_id === "string" && typeof row.owner_user_id === "string"
        ? options.feedbackLink?.({ jobId: row.first_job_id, userId: row.owner_user_id, now: options.now }) ?? null
        : null,
    });
  }
  return accounts;
}

/** Read actual rewards rather than funnel events, so a missed event cannot
 * lose the receipt and a reward reversed before this run sends nothing. */
async function loadReferralRewards(db: SqlDb, since: Date): Promise<ReferralRewardFact[]> {
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    select r.id, r.referrer_workspace_id as workspace_id, r.rewarded_at, c.delta::float8 as credits,
      (select u.email from members m join auth.users u on u.id = m.user_id
        where m.workspace_id = r.referrer_workspace_id and m.role = 'owner'
        order by m.created_at, m.user_id limit 1) as email
    from referrals r
    join credit_ledger c on c.workspace_id = r.referrer_workspace_id
      and c.reason = 'referral' and c.step_key = 'referral:' || r.id::text || ':referrer'
    where r.status = 'rewarded' and r.rewarded_at >= ${since.toISOString()}::timestamptz and c.delta > 0
  `));
  return rows.flatMap((row) => {
    const rewardedAt = date(row.rewarded_at);
    const email = typeof row.email === "string" ? row.email : null;
    if (!rewardedAt || !email || !normalizedEmailKey(email)) return [];
    return [{ referralId: String(row.id), workspaceId: String(row.workspace_id), email, rewardedAt, credits: num(row.credits) }];
  });
}

async function loadPacksDone(db: SqlDb, since: Date): Promise<PackDoneFact[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select e.workspace_id, e.at, e.props ->> 'job_id' as job_id, e.props ->> 'passed' as passed,
        e.props ->> 'needs_review' as needs_review, p.title,
        (select u.email from members m join auth.users u on u.id = m.user_id
          where m.workspace_id = e.workspace_id and m.role = 'owner' order by m.created_at limit 1) as email
      from events e
      left join generation_jobs j
        on j.id = case when (e.props ->> 'job_id') ~ ${UUID} then (e.props ->> 'job_id')::uuid end
        and j.workspace_id = e.workspace_id
      left join products p on p.id = j.product_id
      where e.name = 'funnel.pack_done' and e.workspace_id is not null and e.at >= ${since.toISOString()}::timestamptz
      order by e.at
    `),
  );
  const packs: PackDoneFact[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const jobId = typeof row.job_id === "string" ? row.job_id : null;
    const email = typeof row.email === "string" ? row.email : null;
    const doneAt = date(row.at);
    // A follow up repeats the job id; the pack ready email is about the first finish.
    if (!jobId || !email || !doneAt || seen.has(jobId)) continue;
    seen.add(jobId);
    packs.push({
      jobId,
      workspaceId: String(row.workspace_id),
      email,
      doneAt,
      productTitle: typeof row.title === "string" ? row.title : null,
      passed: num(row.passed),
      needsReview: num(row.needs_review),
      fidelity: null,
    });
  }
  return packs;
}

async function loadLeads(db: SqlDb, since: Date, authUsers: boolean): Promise<LeadFact[]> {
  // Every account inbox key once, then one lookup per lead.
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(
      authUsers
        ? sql`
          with account_keys as materialized (
            select distinct normalized_email_key(u.email) as k from auth.users u where u.email is not null
          )
          select l.email, l.source, l.created_at, l.last_source, l.last_seen_at, l.marketing_consent_at,
            (exists (select 1 from account_keys a where a.k = normalized_email_key(l.email))
              or exists (select 1 from signup_grants g where g.credits > 0 and g.email_key = normalized_email_key(l.email))) as signed_up
          from leads l
          where l.last_seen_at >= ${since.toISOString()}::timestamptz
        `
        : sql`
          select l.email, l.source, l.created_at, l.last_source, l.last_seen_at, l.marketing_consent_at,
            exists (select 1 from signup_grants g where g.credits > 0 and g.email_key = normalized_email_key(l.email)) as signed_up
          from leads l
          where l.last_seen_at >= ${since.toISOString()}::timestamptz
        `,
    ),
  );
  const leads: LeadFact[] = [];
  for (const row of rows) {
    const createdAt = date(row.created_at);
    const lastSeenAt = date(row.last_seen_at);
    if (typeof row.email !== "string" || typeof row.source !== "string" || !createdAt || !lastSeenAt) continue;
    leads.push({
      email: row.email,
      source: row.source,
      createdAt,
      lastSource: typeof row.last_source === "string" ? row.last_source : null,
      lastSeenAt,
      consentAt: date(row.marketing_consent_at),
      signedUp: row.signed_up === true,
    });
  }
  return leads;
}

/** Waitlist spells from the gate's change events (P18-03), oldest first. */
export function pausesFromEvents(
  events: readonly { id: string; name: string; at: Date }[],
  since: Date,
): PauseFact[] {
  const pauses: PauseFact[] = [];
  let open: PauseFact | null = null;
  for (const event of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (event.name === "funnel.acquisition_paused") {
      if (!open) {
        open = { id: event.id, pausedAt: event.at, resumedAt: null };
        pauses.push(open);
      }
    } else if (event.name === "funnel.acquisition_resumed") {
      if (open) {
        open.resumedAt = event.at;
        open = null;
      } else if (pauses.length === 0) {
        // The pause began before the lookback.
        pauses.push({ id: `r${event.id}`, pausedAt: since, resumedAt: event.at });
      }
    }
  }
  return pauses;
}

async function loadPauses(db: SqlDb, since: Date): Promise<PauseFact[]> {
  const rows = rowsOf<{ id: unknown; name: string; at: unknown }>(
    await db.execute(sql`
      select id, name, at from events
      where workspace_id is null and name in ('funnel.acquisition_paused', 'funnel.acquisition_resumed')
        and at >= ${since.toISOString()}::timestamptz
      order by at, id
    `),
  );
  return pausesFromEvents(
    rows.flatMap((row) => {
      const at = date(row.at);
      return at ? [{ id: String(row.id), name: row.name, at }] : [];
    }),
    since,
  );
}

async function loadSent(db: SqlDb, since: Date): Promise<SentFact[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select dedupe_key, template, status, attempts, workspace_id, recipient_key, updated_at
      from email_sends where updated_at >= ${since.toISOString()}::timestamptz
    `),
  );
  return rows.flatMap((row) => {
    const at = date(row.updated_at);
    if (!at) return [];
    return [
      {
        dedupeKey: String(row.dedupe_key),
        template: String(row.template),
        status: String(row.status) as EmailSendStatus,
        attempts: num(row.attempts),
        workspaceId: row.workspace_id ? String(row.workspace_id) : null,
        recipientKey: String(row.recipient_key),
        at,
      },
    ];
  });
}

/** The pack's measured product check (P18-08's packFidelitySummary), read for each pack ready email. */
export type PackFidelityReader = (input: { jobId: string; workspaceId: string }) => Promise<PackDoneFact["fidelity"]>;
/** Injected by the web app, which owns the feedback token format. */
export type FeedbackLinkReader = (input: { jobId: string; userId: string; now: Date }) => string | null;

export interface LoadFactsOptions {
  now: Date;
  acquisitionOpen: boolean;
  typicalPackCredits: number;
  /** CREDIT_TERMS_SENTENCE from the web app (P20-05). */
  creditTerms: string;
  schedule?: LifecycleSchedule;
  fidelity?: PackFidelityReader;
  feedbackLink?: FeedbackLinkReader;
  /** Owner addresses whose workspaces get no lifecycle email: the
   * operators in OPS_EMAILS, whose prospect packs (P18-04) and test packs
   * are not seller activity (the funnel report leaves them out the same way). */
  excludeOwnerEmails?: readonly string[];
}

export async function loadLifecycleFacts(db: SqlDb, options: LoadFactsOptions): Promise<LifecycleFacts> {
  const schedule = options.schedule ?? lifecycleSchedule;
  const since = new Date(options.now.getTime() - schedule.lookbackDays * DAY_MS);
  const authUsers = await hasAuthUsers(db);
  const excluded = new Set((options.excludeOwnerEmails ?? []).map((email) => email.trim().toLowerCase()));
  const kept = <T extends { email: string }>(rows: T[]): T[] => rows.filter((row) => !excluded.has(row.email.trim().toLowerCase()));
  const [allAccounts, allPacksDone, leads, pauses, sent, allReferralsRewarded] = await Promise.all([
    authUsers ? loadAccounts(db, since, options) : Promise.resolve([]),
    authUsers ? loadPacksDone(db, new Date(options.now.getTime() - (schedule.templates.pack_ready.maxLateHours + 1) * 60 * 60 * 1000)) : Promise.resolve([]),
    loadLeads(db, since, authUsers),
    loadPauses(db, since),
    loadSent(db, since),
    authUsers ? loadReferralRewards(db, since) : Promise.resolve([]),
  ]);
  const accounts = kept(allAccounts);
  const packsDone = kept(allPacksDone);
  const referralsRewarded = kept(allReferralsRewarded);
  if (options.fidelity) {
    // Only packs whose email has not gone yet need their numbers.
    const done = new Set(sent.filter((s) => s.status === "sent" || s.status === "suppressed").map((s) => s.dedupeKey));
    for (const pack of packsDone) {
      if (done.has(`pack_ready:${pack.jobId}`) || pack.passed < 1) continue;
      pack.fidelity = await options.fidelity({ jobId: pack.jobId, workspaceId: pack.workspaceId }).catch(() => null);
    }
  }
  const keys = new Set<string>();
  for (const email of [...accounts.map((a) => a.email), ...packsDone.map((p) => p.email), ...leads.map((l) => l.email), ...referralsRewarded.map((r) => r.email)]) {
    const key = normalizedEmailKey(email);
    if (key) keys.add(key);
  }
  const suppressions = await suppressionsOf(db, [...keys]);
  return {
    now: options.now,
    acquisitionOpen: options.acquisitionOpen,
    pricing: pricingFacts(options.typicalPackCredits, options.creditTerms),
    accounts,
    packsDone,
    referralsRewarded,
    leads,
    pauses,
    sent,
    suppressions,
  };
}
