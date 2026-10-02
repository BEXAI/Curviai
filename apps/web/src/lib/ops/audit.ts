/**
 * The operator audit trail (docs/phases/PHASE_20.md principle 9, P20-66).
 * Every operator mutation (a switch, a credit grant, a requeue, the release
 * script's deploy_pending writes) re-checks isOperator on the server and
 * writes one ops_audit row with the operator, the action, its target and any
 * force flag.
 *
 * ops_audit is a platform table created by migration ops_switches_and_audit
 * (Lane 5 Operator basics): RLS on with no client policies, no anon or
 * authenticated privileges, the no_oauth_clients policy, and no foreign key
 * that cascades, so deleting a workspace never deletes its audit trail. It
 * is not the events table, which members can insert into and which cascades
 * on workspace delete. Until that migration is applied, writeOpsAudit fails
 * (the table does not exist); nothing calls it before Lane 5 lands.
 */

import { sql } from "@curvi/db";

/** One operator action. */
export interface OpsAuditEntry {
  /** The signed in operator (or the CLI's OPS_OPERATOR_EMAIL). */
  operatorEmail: string;
  /** What was done, "<area>.<verb>": "switch.set", "credits.grant". */
  action: string;
  /** What it was done to: "platform_setting", "workspace", "job". */
  targetKind: string;
  /** The key or id of the target, when there is one. */
  targetId: string | null;
  /** The workspace affected, when there is one. Stored with no foreign key. */
  workspaceId?: string | null;
  /** Anything else worth keeping: amounts, old and new values, notes. Never
   * secrets or customer content. */
  detail?: Record<string, unknown>;
  /** True when the operator overrode a safety check (the Force box). */
  forced?: boolean;
}

/** Anything that runs SQL: the owner connection (Db), a transaction on it,
 * or the PGlite test database. */
export interface OpsAuditExecutor {
  execute(query: ReturnType<typeof sql>): PromiseLike<unknown>;
}

/**
 * Writes one ops_audit row. Throws when the write fails: an operator action
 * whose audit row cannot be written should fail too, so callers run it in
 * the same transaction as the change.
 */
export async function writeOpsAudit(db: OpsAuditExecutor, entry: OpsAuditEntry, at: Date = new Date()): Promise<void> {
  await db.execute(sql`
    insert into ops_audit (at, operator_email, action, target_kind, target_id, workspace_id, detail, forced)
    values (
      ${at.toISOString()}::timestamptz,
      ${entry.operatorEmail.trim().toLowerCase()},
      ${entry.action},
      ${entry.targetKind},
      ${entry.targetId},
      ${entry.workspaceId ?? null}::uuid,
      ${JSON.stringify(entry.detail ?? {})}::jsonb,
      ${entry.forced ?? false}
    )
  `);
}
