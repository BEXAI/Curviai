/** One exclusion policy for customer metrics and operator synthetic packs.
 * Cost meters, safety caps and operational recovery never use this filter. */
import { sql, type Db } from "@curvi/db";
import { opsEmails } from "@/lib/ops";
type SQL = ReturnType<typeof sql>;
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];

/** Resolve operator-owned workspaces from authoritative membership/Auth rows. */
export async function operatorWorkspaceIds(db: Db, emails: readonly string[] = opsEmails()): Promise<string[]> {
  const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const present = rowsOf<{ present: boolean }>(await db.execute(sql`select to_regclass('auth.users') is not null as present`));
  if (!present[0]?.present) return []; // Isolated schema tests have no Auth schema.
  const rows = rowsOf<{ workspace_id: string }>(await db.execute(sql`
    select distinct m.workspace_id from members m join auth.users u on u.id = m.user_id
    where m.role = 'owner' and lower(u.email) in (${sql.join(normalized.map((email) => sql`${email}`), sql`, `)})`));
  return rows.map((row) => String(row.workspace_id));
}

/** The caller supplies a fixed SQL column, never a user-provided identifier. */
export function customerWorkspace(excluded: readonly string[], column: SQL): SQL {
  return excluded.length === 0 ? sql`true` : sql`(${column} is null or ${column} not in (${sql.join(excluded.map((id) => sql`${id}::uuid`), sql`, `)}))`;
}

export function customerUser(excluded: readonly string[], column: SQL): SQL {
  return excluded.length === 0 ? sql`true` : sql`not exists (
    select 1 from members metric_member where metric_member.user_id = ${column}
    and not ${customerWorkspace(excluded, sql`metric_member.workspace_id`)})`;
}
