/**
 * Referral give and get credits (docs/phases/PHASE_18.md P18-24, founder
 * decision 12), on the owner connection. Every number is the seed's
 * referralReward (credits.ts); the switch is lib/referrals/switch.ts.
 *
 * The life of a referral (one row per referred workspace):
 * - Issue: a workspace's code is created the first time an owner or admin
 *   opens /app/settings/referrals (issueReferralCode).
 * - Signup: on a fresh verification whose signup link carried ref, the auth
 *   callback records a pending row (recordReferralSignup), or a rejected one
 *   for a self referral or an email that already had a signup grant.
 * - Qualify and reward: the Stripe webhook calls qualifyReferral with the
 *   referred workspace's paid grant. A pending row qualifies on that
 *   payment and, in the same transaction, both sides get referralReward
 *   credits as ledger rows (reason referral, source system, expiring like
 *   top ups) with the step keys referral:<id>:referrer and
 *   referral:<id>:referred, which credit_ledger_referral_step_uq keeps to
 *   one row each. It is rejected instead when rewards are off, the
 *   referrer's workspace is gone, both sides share a Stripe customer, the
 *   referred payment used a card that also paid on the referrer's customer
 *   (same_card; the webhook reads the fingerprints from Stripe before it
 *   calls this, lib/referrals/stripe.ts), or the referrer already has
 *   monthlyCapPerReferrer rewards this UTC month.
 * - Reverse: a refund or dispute of the qualifying payment within
 *   clawbackDays takes both rewards back (reverseReferral) with negative
 *   referral rows, never below a zero balance (the Phase 10 decision 3 rule
 *   for every clawback), and marks the row reversed.
 *
 * Each step runs under a row lock on the referral, so a retried Stripe
 * delivery finds the step done; the referrer's workspace row is locked
 * before the monthly count, so two payments cannot both take the last slot.
 */

import { recordFunnelEvent, sql, type Db } from "@curvi/db";
import { referralCodePolicy, referralReward } from "@curvi/pipeline/seed";
import { generateReferralCode } from "./codes";

export type ReferralRejectReason =
  | "self_referral"
  | "email_reused"
  | "rewards_off"
  | "referrer_gone"
  | "same_customer"
  | "same_card"
  | "monthly_cap";

export type ReferralReversalReason = "refunded" | "disputed";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Pick<Db, "execute">;

const DAY_MS = 24 * 60 * 60 * 1000;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

async function rows<T>(db: Executor | Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return rowsOf<T>(await db.execute(query));
}

function roundCredits(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The ledger step key of one side's reward, and of its reversal. */
export function referralStepKey(referralId: string, side: "referrer" | "referred", reversed = false): string {
  return `referral:${referralId}:${side}${reversed ? ":reversed" : ""}`;
}

/** The first instant of the UTC calendar month of `at`, and of the next. */
export function utcMonthBounds(at: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

// --- Codes -----------------------------------------------------------------

/** The workspace's code, created on first use. */
export async function issueReferralCode(
  db: Db,
  workspaceId: string,
  generate: () => string = () => generateReferralCode(),
): Promise<{ code: string; created: boolean }> {
  for (let attempt = 0; attempt < referralCodePolicy.issueAttempts; attempt += 1) {
    const existing = await rows<{ code: string }>(
      db,
      sql`select code from referral_codes where workspace_id = ${workspaceId}::uuid`,
    );
    if (existing[0]) {
      return { code: existing[0].code, created: false };
    }
    const candidate = generate();
    // A conflict is either this workspace getting a code meanwhile (the next
    // read returns it) or another workspace's code (try a new one).
    const inserted = await rows<{ code: string }>(
      db,
      sql`insert into referral_codes (workspace_id, code) values (${workspaceId}::uuid, ${candidate})
          on conflict do nothing returning code`,
    );
    if (inserted[0]) {
      await recordFunnelEvent(db, { workspaceId, name: "referral_link_created" });
      return { code: inserted[0].code, created: true };
    }
  }
  throw new Error("Could not issue a referral code.");
}

export interface ReferralSummary {
  /** Signups from the workspace's link. */
  signups: number;
  /** Signups waiting for their first payment. */
  pending: number;
  /** Referrals that paid out, ever. */
  rewarded: number;
  /** Rewards counted against this UTC month's cap. */
  rewardedThisMonth: number;
}

/** What /app/settings/referrals shows the referrer. */
export async function referralSummary(db: Executor, workspaceId: string, now: Date = new Date()): Promise<ReferralSummary> {
  const { start, end } = utcMonthBounds(now);
  const [row] = await rows<{ signups: number | string; pending: number | string; rewarded: number | string; month: number | string }>(
    db,
    sql`select
          count(*) as signups,
          count(*) filter (where status in ('pending', 'qualified')) as pending,
          count(*) filter (where status = 'rewarded') as rewarded,
          count(*) filter (where rewarded_at >= ${start.toISOString()}::timestamptz and rewarded_at < ${end.toISOString()}::timestamptz) as month
        from referrals
        where referrer_workspace_id = ${workspaceId}::uuid`,
  );
  return {
    signups: Number(row?.signups ?? 0),
    pending: Number(row?.pending ?? 0),
    rewarded: Number(row?.rewarded ?? 0),
    rewardedThisMonth: Number(row?.month ?? 0),
  };
}

// --- Signup ----------------------------------------------------------------

export type ReferralSignupOutcome =
  | { outcome: "pending"; referralId: string }
  | { outcome: "rejected"; referralId: string; reason: ReferralRejectReason }
  | { outcome: "already_recorded" }
  | { outcome: "unknown_code" }
  | { outcome: "no_workspace" };

/**
 * A new account that signed up from an invite link. Call it only while
 * referrals are on, on a fresh verification. One row per referred
 * workspace: a second call writes nothing.
 */
export async function recordReferralSignup(
  db: Db,
  input: { userId: string; code: string; now?: Date },
): Promise<ReferralSignupOutcome> {
  const now = input.now ?? new Date();
  const [codeRow] = await rows<{ workspace_id: string }>(
    db,
    sql`select workspace_id from referral_codes where code = ${input.code}`,
  );
  if (!codeRow) {
    return { outcome: "unknown_code" };
  }
  const referrer = codeRow.workspace_id;
  const [membership] = await rows<{ workspace_id: string }>(
    db,
    sql`select workspace_id from members where user_id = ${input.userId}::uuid order by created_at limit 1`,
  );
  if (!membership) {
    return { outcome: "no_workspace" };
  }
  const referred = membership.workspace_id;
  const [checks] = await rows<{ self: boolean; reused: boolean }>(
    db,
    sql`select
          (${referred}::uuid = ${referrer}::uuid
            or exists (select 1 from members where user_id = ${input.userId}::uuid and workspace_id = ${referrer}::uuid)) as self,
          exists (
            select 1 from signup_grants mine
            where mine.user_id = ${input.userId}::uuid
              and (
                mine.withheld_reason = 'email_already_granted'
                or (mine.email_key is not null and exists (
                  select 1 from signup_grants other
                  where other.email_key = mine.email_key and other.user_id <> mine.user_id
                ))
              )
          ) as reused`,
  );
  const reason: ReferralRejectReason | null = checks?.self ? "self_referral" : checks?.reused ? "email_reused" : null;
  const inserted = await rows<{ id: string }>(
    db,
    sql`insert into referrals (code, referrer_workspace_id, referred_workspace_id, status, reject_reason, created_at)
        values (${input.code}, ${referrer}::uuid, ${referred}::uuid, ${reason ? "rejected" : "pending"}, ${reason},
                ${now.toISOString()}::timestamptz)
        on conflict (referred_workspace_id) do nothing
        returning id`,
  );
  if (!inserted[0]) {
    return { outcome: "already_recorded" };
  }
  await recordFunnelEvent(db, {
    workspaceId: referred,
    name: "referral_signup",
    at: now,
    props: { status: reason ? "rejected" : "pending", reason },
  });
  return reason
    ? { outcome: "rejected", referralId: inserted[0].id, reason }
    : { outcome: "pending", referralId: inserted[0].id };
}

// --- Qualify and reward ----------------------------------------------------

export type QualifyOutcome =
  | { outcome: "rewarded"; referralId: string; referrerWorkspaceId: string; referredWorkspaceId: string; credits: number }
  | { outcome: "rejected"; referralId: string; reason: ReferralRejectReason; qualified: boolean }
  /** Already rewarded, rejected or reversed: nothing to do. */
  | { outcome: "settled"; referralId: string }
  | { outcome: "no_referral" };

interface ReferralRow {
  id: string;
  status: string;
  referrer_workspace_id: string | null;
  referred_workspace_id: string | null;
  qualified_at: string | Date | null;
}

async function reject(tx: Tx, id: string, reason: ReferralRejectReason): Promise<void> {
  await tx.execute(sql`update referrals set status = 'rejected', reject_reason = ${reason} where id = ${id}::uuid`);
}

/**
 * The referred workspace paid (paymentKey is the billing grant key,
 * invoice:<id> or checkout:<id>). Qualifies a pending referral on this
 * payment and rewards both sides, or rejects it; a referral qualified
 * earlier whose reward did not land is rewarded now.
 */
export async function qualifyReferral(
  db: Db,
  input: {
    referredWorkspaceId: string;
    paymentKey: string;
    enabled: boolean;
    /** The referred payment's card (or bank account) also paid on the
     * referrer's Stripe customer: one person on both sides. */
    sharedPaymentMethod?: boolean;
    now?: Date;
  },
): Promise<QualifyOutcome> {
  const now = input.now ?? new Date();
  const outcome = await db.transaction(async (tx): Promise<QualifyOutcome> => {
    const [row] = await rows<ReferralRow>(
      tx,
      sql`select id, status, referrer_workspace_id, referred_workspace_id, qualified_at from referrals
          where referred_workspace_id = ${input.referredWorkspaceId}::uuid
          for update`,
    );
    if (!row) {
      return { outcome: "no_referral" };
    }
    if (row.status !== "pending" && row.status !== "qualified") {
      return { outcome: "settled", referralId: row.id };
    }
    const wasPending = row.status === "pending";
    if (!input.enabled) {
      await reject(tx, row.id, "rewards_off");
      return { outcome: "rejected", referralId: row.id, reason: "rewards_off", qualified: false };
    }
    if (wasPending) {
      await tx.execute(
        sql`update referrals set status = 'qualified', qualified_at = ${now.toISOString()}::timestamptz,
              qualifying_payment = ${input.paymentKey}
            where id = ${row.id}::uuid`,
      );
    }
    const referrer = row.referrer_workspace_id;
    const referred = input.referredWorkspaceId;
    if (!referrer) {
      await reject(tx, row.id, "referrer_gone");
      return { outcome: "rejected", referralId: row.id, reason: "referrer_gone", qualified: true };
    }
    const customers = await rows<{ id: string; stripe_customer_id: string | null }>(
      tx,
      sql`select id, stripe_customer_id from workspaces where id in (${referrer}::uuid, ${referred}::uuid)`,
    );
    const referrerCustomer = customers.find((c) => c.id === referrer)?.stripe_customer_id ?? null;
    const referredCustomer = customers.find((c) => c.id === referred)?.stripe_customer_id ?? null;
    if (!customers.some((c) => c.id === referrer)) {
      await reject(tx, row.id, "referrer_gone");
      return { outcome: "rejected", referralId: row.id, reason: "referrer_gone", qualified: true };
    }
    if (referrerCustomer && referrerCustomer === referredCustomer) {
      await reject(tx, row.id, "same_customer");
      return { outcome: "rejected", referralId: row.id, reason: "same_customer", qualified: true };
    }
    if (input.sharedPaymentMethod) {
      await reject(tx, row.id, "same_card");
      return { outcome: "rejected", referralId: row.id, reason: "same_card", qualified: true };
    }
    // One reward at a time per referrer, so the monthly count holds.
    await tx.execute(sql`select 1 from workspaces where id = ${referrer}::uuid for update`);
    const { start, end } = utcMonthBounds(now);
    const [count] = await rows<{ n: number | string }>(
      tx,
      sql`select count(*) as n from referrals
          where referrer_workspace_id = ${referrer}::uuid
            and rewarded_at >= ${start.toISOString()}::timestamptz and rewarded_at < ${end.toISOString()}::timestamptz`,
    );
    if (Number(count?.n ?? 0) >= referralReward.monthlyCapPerReferrer) {
      await reject(tx, row.id, "monthly_cap");
      return { outcome: "rejected", referralId: row.id, reason: "monthly_cap", qualified: true };
    }
    const credits = referralReward.credits;
    // No expires_at: credits never expire while the account is open
    // (seed creditExpiry, docs/phases/PHASE_20.md P20-05).
    await tx.execute(
      sql`insert into credit_ledger (workspace_id, delta, reason, source, step_key)
          values
            (${referrer}::uuid, ${credits}, 'referral', 'system', ${referralStepKey(row.id, "referrer")}),
            (${referred}::uuid, ${credits}, 'referral', 'system', ${referralStepKey(row.id, "referred")})
          on conflict do nothing`,
    );
    await tx.execute(
      sql`update referrals set status = 'rewarded', rewarded_at = ${now.toISOString()}::timestamptz where id = ${row.id}::uuid`,
    );
    return { outcome: "rewarded", referralId: row.id, referrerWorkspaceId: referrer, referredWorkspaceId: referred, credits };
  });

  if (outcome.outcome === "rewarded" || (outcome.outcome === "rejected" && outcome.qualified)) {
    await recordFunnelEvent(db, {
      workspaceId: input.referredWorkspaceId,
      name: "referral_qualified",
      at: now,
      props: { result: outcome.outcome === "rewarded" ? "rewarded" : outcome.reason },
    });
  }
  if (outcome.outcome === "rewarded") {
    await recordFunnelEvent(db, {
      workspaceId: outcome.referrerWorkspaceId,
      name: "referral_rewarded",
      at: now,
      props: { credits: outcome.credits },
    });
  }
  return outcome;
}

// --- Reverse ---------------------------------------------------------------

export type ReverseOutcome =
  | { outcome: "reversed"; referralId: string; taken: { referrer: number; referred: number } }
  /** Qualified on this payment but never rewarded: rejected, nothing to take. */
  | { outcome: "rejected"; referralId: string }
  | { outcome: "too_late"; referralId: string }
  | { outcome: "settled"; referralId: string }
  | { outcome: "no_referral" };

/**
 * A refund or dispute of the payment `paymentKey` (the billing grant key).
 * Takes back what each side still holds of its reward, once.
 */
export async function reverseReferral(
  db: Db,
  input: { paymentKey: string; reason: ReferralReversalReason; at?: Date },
): Promise<ReverseOutcome> {
  const at = input.at ?? new Date();
  return db.transaction(async (tx): Promise<ReverseOutcome> => {
    const [row] = await rows<ReferralRow>(
      tx,
      sql`select id, status, referrer_workspace_id, referred_workspace_id, qualified_at from referrals
          where qualifying_payment = ${input.paymentKey}
          order by created_at
          limit 1
          for update`,
    );
    if (!row) {
      return { outcome: "no_referral" };
    }
    if (row.status === "qualified") {
      await tx.execute(
        sql`update referrals set status = 'rejected', reject_reason = ${input.reason} where id = ${row.id}::uuid`,
      );
      return { outcome: "rejected", referralId: row.id };
    }
    if (row.status !== "rewarded") {
      return { outcome: "settled", referralId: row.id };
    }
    const qualifiedAt = row.qualified_at ? new Date(row.qualified_at).getTime() : Number.NaN;
    if (!(at.getTime() - qualifiedAt <= referralReward.clawbackDays * DAY_MS)) {
      return { outcome: "too_late", referralId: row.id };
    }
    const taken = { referrer: 0, referred: 0 };
    for (const side of ["referrer", "referred"] as const) {
      const workspaceId = side === "referrer" ? row.referrer_workspace_id : row.referred_workspace_id;
      if (!workspaceId) {
        continue;
      }
      await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
      const [granted] = await rows<{ delta: number | string }>(
        tx,
        sql`select delta from credit_ledger
            where workspace_id = ${workspaceId}::uuid and reason = 'referral' and step_key = ${referralStepKey(row.id, side)}`,
      );
      if (!granted) {
        continue;
      }
      const [balance] = await rows<{ balance: number | string }>(
        tx,
        sql`select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = ${workspaceId}::uuid`,
      );
      const take = roundCredits(Math.min(Number(granted.delta), Math.max(0, Number(balance?.balance ?? 0))));
      if (take > 0) {
        await tx.execute(
          sql`insert into credit_ledger (workspace_id, delta, reason, source, step_key)
              values (${workspaceId}::uuid, ${-take}, 'referral', 'system', ${referralStepKey(row.id, side, true)})
              on conflict do nothing`,
        );
      }
      taken[side] = take;
    }
    await tx.execute(
      sql`update referrals set status = 'reversed', reject_reason = ${input.reason}, reversed_at = ${at.toISOString()}::timestamptz
          where id = ${row.id}::uuid`,
    );
    return { outcome: "reversed", referralId: row.id, taken };
  });
}
