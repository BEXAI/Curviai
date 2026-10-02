/**
 * Operator credit grants (docs/phases/PHASE_20.md P20-66): the founder's
 * audited way to grant credits to a workspace, or to take credits back,
 * without SQL against the production ledger. The CLI
 * (apps/web/scripts/grant-credits.ts, pnpm ops:grant-credits) calls it
 * today; the ops cockpit (P20-45) adds a button over the same function.
 *
 * One transaction does everything, so a grant and its audit row land
 * together or not at all:
 * 1. A transaction scoped advisory lock serializes every operator grant,
 *    so two at once cannot both pass the monthly cap.
 * 2. A key already in ops_audit is a repeat: nothing is written and the
 *    first result comes back. ops_audit is the source of truth because no
 *    client role can write it (the events table is member insertable).
 * 3. The workspace row is locked as the ledger functions lock it
 *    (reserve_credits, the billing store), and the balance is read.
 * 4. The caps from the seed's opsGrants apply: one grant or correction is
 *    at most maxCreditsPerGrant either way, and grants in a calendar month
 *    (UTC) add up to at most maxCreditsPerMonth, counted from ops_audit.
 * 5. The dedupe claim billing:system:ops_grant:<key> goes into events with
 *    the unique index from migration 0003, the same claim the webhook's
 *    DbBillingStore.recordGrantOnce makes with its event source set to
 *    system, so a retried call grants once. Every member of the workspace,
 *    clients included, can read its events, so the claim holds only the
 *    credits and a neutral label ("Credits added by Curvi"), never the
 *    operator or the note (security review 11); the note stays in
 *    ops_audit.
 * 6. The ledger row: a grant row (source system), or for a negative
 *    correction a refund row that never takes the balance below zero. Both
 *    carry step_key ops_grant:<key>.
 * 7. writeOpsAudit records the operator, the workspace id, the credits,
 *    the note and the balances (no workspace name: no customer content).
 * Deviation from the plan's "through DbBillingStore.recordGrantOnce": that
 * method opens its own transaction, which could hold neither the cap check
 * nor the audit row, so this module makes the same claim in its own.
 *
 * Every call re-checks that the operator is listed in OPS_EMAILS (principle
 * 9), whatever the caller already checked.
 */

import { randomUUID } from "node:crypto";
import { creditLedger, events, sql, type Db } from "@curvi/db";
import { opsGrants } from "@curvi/pipeline/seed";
import { opsEmails } from "@/lib/ops";
import { isUuid } from "@/lib/validation/ids";
import { writeOpsAudit } from "./audit";

/** The longest note a grant keeps. */
export const GRANT_NOTE_MAX = 120;

/** ops_audit actions this module writes. */
export const GRANT_ACTION = "credits.grant";
export const CORRECT_ACTION = "credits.correct";

/** One advisory lock for every operator grant. */
const GRANT_LOCK = "billing:system:lock:ops_grants";

export type GrantRefusalCode =
  | "not_operator"
  | "invalid_workspace"
  | "invalid_credits"
  | "invalid_note"
  | "invalid_key"
  | "no_workspace"
  | "over_grant_cap"
  | "over_month_cap"
  | "nothing_to_take"
  | "key_reused";

/** A grant that was refused before anything was written. The message is
 * founder facing and says what to do. */
export class GrantRefusal extends Error {
  constructor(
    readonly code: GrantRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "GrantRefusal";
  }
}

export interface GrantCreditsInput {
  workspaceId: string;
  /** Credits to add; a negative number takes credits back (a correction).
   * At most one decimal place, like the ledger. */
  credits: number;
  /** Why, in at most GRANT_NOTE_MAX characters. */
  note: string;
  /** The operator's email; must be listed in OPS_EMAILS. */
  operator: string;
  /** The dedupe key (a uuid). A retry with the same key grants once. A new
   * one is made when it is left out. */
  key?: string;
}

export interface GrantOutcome {
  /** granted or corrected now, or a repeat of a key already used. */
  status: "granted" | "corrected" | "duplicate";
  key: string;
  workspaceId: string;
  workspaceName: string;
  /** What was asked. */
  credits: number;
  /** What the ledger row added: the same for a grant, and for a correction
   * the negative amount the balance allowed. */
  applied: number;
  balanceBefore: number;
  balanceAfter: number;
  /** Grant credits left this calendar month under maxCreditsPerMonth. */
  leftThisMonth: number;
}

/** The stored audit detail of one grant. */
interface GrantDetail {
  key: string;
  credits: number;
  applied: number;
  note: string;
  balanceBefore: number;
  balanceAfter: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (((result as { rows?: T[] }).rows ?? []) as T[]);
}

/** The first UTC instant of `now`'s calendar month. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Credits as the ledger keeps them: finite, not zero, one decimal at most. */
function validCredits(value: number): boolean {
  return Number.isFinite(value) && value !== 0 && Math.abs(Math.round(value * 10) - value * 10) < 1e-6;
}

function credits(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Checks the input and returns it normalized; throws GrantRefusal. */
function checkInput(input: GrantCreditsInput): Required<GrantCreditsInput> {
  const operator = input.operator.trim().toLowerCase();
  if (!operator || !opsEmails().includes(operator)) {
    throw new GrantRefusal(
      "not_operator",
      `${operator || "The operator"} is not listed in OPS_EMAILS, so it cannot grant credits.`,
    );
  }
  if (!isUuid(input.workspaceId)) {
    throw new GrantRefusal("invalid_workspace", "The workspace must be a workspace id.");
  }
  if (!validCredits(input.credits)) {
    throw new GrantRefusal(
      "invalid_credits",
      "Credits must be a number other than zero, with at most one decimal place. Use a negative number to take credits back.",
    );
  }
  const note = input.note.trim();
  if (note.length === 0 || note.length > GRANT_NOTE_MAX) {
    throw new GrantRefusal("invalid_note", `Add a note of 1 to ${GRANT_NOTE_MAX} characters that says why.`);
  }
  const key = input.key?.trim().toLowerCase() || randomUUID();
  if (!isUuid(key)) {
    throw new GrantRefusal("invalid_key", "The key must be a uuid, as printed by an earlier run.");
  }
  return { workspaceId: input.workspaceId.toLowerCase(), credits: input.credits, note, operator, key };
}

/** Grant credits used since `since`, from ops_audit. */
async function grantedSince(tx: Tx, since: Date): Promise<number> {
  const rows = rowsOf<{ used: string | number }>(
    await tx.execute(sql`
      select coalesce(sum((detail->>'applied')::numeric), 0) as used
      from ops_audit
      where action = ${GRANT_ACTION} and at >= ${since.toISOString()}::timestamptz
    `),
  );
  return Number(rows[0]?.used ?? 0);
}

async function earlierGrant(tx: Tx, key: string): Promise<{ workspaceId: string | null; detail: GrantDetail } | null> {
  const rows = rowsOf<{ workspace_id: string | null; detail: GrantDetail }>(
    await tx.execute(sql`
      select workspace_id, detail from ops_audit
      where action in (${GRANT_ACTION}, ${CORRECT_ACTION}) and detail->>'key' = ${key}
      order by id
      limit 1
    `),
  );
  const row = rows[0];
  return row ? { workspaceId: row.workspace_id, detail: row.detail } : null;
}

async function balanceOf(tx: Tx, workspaceId: string): Promise<number> {
  const rows = rowsOf<{ balance: string | number }>(
    await tx.execute(sql`select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = ${workspaceId}`),
  );
  return Number(rows[0]?.balance ?? 0);
}

/**
 * Grants `credits` to a workspace (or takes them back when negative), once
 * per key, with an ops_audit row. Throws GrantRefusal before writing
 * anything when the operator, the input, a cap or the balance says no.
 */
export async function grantCredits(db: Db, input: GrantCreditsInput, now: Date = new Date()): Promise<GrantOutcome> {
  const checked = checkInput(input);
  const { workspaceId, note, operator, key } = checked;
  const asked = Math.round(checked.credits * 10) / 10;
  const { maxCreditsPerGrant, maxCreditsPerMonth } = opsGrants;

  return db.transaction(async (tx): Promise<GrantOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${GRANT_LOCK}))`);
    const leftNow = async () => Math.max(0, maxCreditsPerMonth - (await grantedSince(tx, monthStartUtc(now))));

    const earlier = await earlierGrant(tx, key);
    if (earlier) {
      if (earlier.workspaceId !== workspaceId || Number(earlier.detail.credits) !== asked) {
        throw new GrantRefusal(
          "key_reused",
          `Key ${key} was already used for another grant (${credits(Number(earlier.detail.credits))} credits to workspace ${earlier.workspaceId ?? "unknown"}). Leave out --key to make a new grant.`,
        );
      }
      const [named] = rowsOf<{ name: string }>(await tx.execute(sql`select name from workspaces where id = ${workspaceId}`));
      return {
        status: "duplicate",
        key,
        workspaceId,
        workspaceName: named?.name ?? "a deleted workspace",
        credits: asked,
        applied: Number(earlier.detail.applied),
        balanceBefore: Number(earlier.detail.balanceBefore),
        balanceAfter: Number(earlier.detail.balanceAfter),
        leftThisMonth: await leftNow(),
      };
    }

    const [workspace] = rowsOf<{ id: string; name: string }>(
      await tx.execute(sql`select id, name from workspaces where id = ${workspaceId} for update`),
    );
    if (!workspace) {
      throw new GrantRefusal("no_workspace", `No workspace has the id ${workspaceId}.`);
    }

    const left = await leftNow();
    if (Math.abs(asked) > maxCreditsPerGrant) {
      throw new GrantRefusal(
        "over_grant_cap",
        `One grant or correction is at most ${maxCreditsPerGrant} credits, and ${credits(Math.abs(asked))} were asked. ${credits(left)} credits are left this month under the grant cap.`,
      );
    }
    if (asked > left) {
      throw new GrantRefusal(
        "over_month_cap",
        `Only ${credits(left)} credits are left this month under the grant cap of ${maxCreditsPerMonth}, and ${credits(asked)} were asked.`,
      );
    }

    const balanceBefore = await balanceOf(tx, workspaceId);
    // A correction takes back at most what the balance holds, never below zero.
    const applied = asked > 0 ? asked : -Math.min(-asked, Math.max(0, Math.round(balanceBefore * 10) / 10));
    if (applied === 0) {
      throw new GrantRefusal(
        "nothing_to_take",
        `The balance of ${workspace.name} is ${credits(balanceBefore)}, so there is nothing to take back.`,
      );
    }
    const balanceAfter = Math.round((balanceBefore + applied) * 10) / 10;

    const claimed = await tx
      .insert(events)
      .values({
        workspaceId,
        name: `billing:system:ops_grant:${key}`,
        // Every member of the workspace (clients too) can read events
        // (0002), so the claim carries a neutral label only; the operator's
        // note stays in ops_audit (security review 11).
        props: { kind: "ops_grant", credits: asked, applied, label: applied > 0 ? "Credits added by Curvi" : "Credits corrected by Curvi" },
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
    if (claimed.length === 0) {
      // A claim with no audit row was not written here.
      throw new GrantRefusal("key_reused", `Key ${key} is already taken. Leave out --key to make a new grant.`);
    }

    await tx.insert(creditLedger).values({
      workspaceId,
      delta: applied,
      reason: applied > 0 ? "grant" : "refund",
      source: "system",
      stepKey: `ops_grant:${key}`,
    });

    const detail: GrantDetail = {
      key,
      credits: asked,
      applied,
      note,
      balanceBefore,
      balanceAfter,
    };
    await writeOpsAudit(
      tx,
      {
        operatorEmail: operator,
        action: applied > 0 ? GRANT_ACTION : CORRECT_ACTION,
        targetKind: "workspace",
        targetId: workspaceId,
        workspaceId,
        detail: { ...detail },
      },
      now,
    );

    return {
      status: applied > 0 ? "granted" : "corrected",
      key,
      workspaceId,
      workspaceName: workspace.name,
      credits: asked,
      applied,
      balanceBefore,
      balanceAfter,
      leftThisMonth: applied > 0 ? Math.max(0, left - applied) : left,
    };
  });
}

/** The founder facing line for an outcome (P20-66 copy). */
export function grantOutcomeText(outcome: GrantOutcome): string {
  const where = `${outcome.workspaceName} (${outcome.workspaceId})`;
  const balance = `Balance ${credits(outcome.balanceBefore)} to ${credits(outcome.balanceAfter)}.`;
  const left = `${credits(outcome.leftThisMonth)} credits left this month under the grant cap.`;
  switch (outcome.status) {
    case "granted":
      return `Granted ${credits(outcome.applied)} credits to ${where}. ${balance} ${left}`;
    case "corrected": {
      const taken = credits(-outcome.applied);
      const short =
        -outcome.applied < -outcome.credits
          ? ` You asked for ${credits(-outcome.credits)}; the balance never goes below zero, so ${taken} is all it allowed.`
          : "";
      return `Took back ${taken} credits from ${where}. ${balance}${short} ${left}`;
    }
    case "duplicate":
      return `Key ${outcome.key} was already used for this grant, so nothing changed. It ${
        outcome.applied > 0 ? `granted ${credits(outcome.applied)} credits to` : `took back ${credits(-outcome.applied)} credits from`
      } ${where}. ${balance} ${left}`;
  }
}
