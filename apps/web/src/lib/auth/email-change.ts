import { sql, type Db } from "@curvi/db";
import { normalizedEmailKey, rowsOf, type SqlDb } from "@curvi/email";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripeApiKey } from "@/lib/env";

/** Preserve old suppression, and never weaken the destination's suppression. */
export async function carryEmailSuppression(db: SqlDb, oldKey: string, newKey: string) {
  await db.execute(sql`
    insert into email_suppressions (recipient_key, scope, reason, created_at)
    select ${newKey}, scope, reason, created_at from email_suppressions where recipient_key = ${oldKey}
    on conflict (recipient_key) do update set scope = excluded.scope, reason = excluded.reason
    where email_suppressions.scope = 'marketing' and excluded.scope = 'all'
  `);
}
/** A platform table prevents clients from forging the old identity. */
export async function rememberEmailChange(db: Db, userId: string, oldEmail: string, newEmail: string) {
  const value = JSON.stringify({ oldKey: normalizedEmailKey(oldEmail), newKey: normalizedEmailKey(newEmail) });
  await db.execute(sql`insert into platform_settings (key, value) values (${`auth:email-change:${userId}`}, ${value}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}
/** The user comes from a verified Auth exchange, never a submitted email. */
export async function finishEmailChange(db: Db, user: { id: string; email?: string; email_confirmed_at?: string }) {
  if (!user.email || !user.email_confirmed_at) return;
  const key = `auth:email-change:${user.id}`;
  const pending = rowsOf<{ value: { oldKey?: string; newKey?: string } }>(await db.execute(sql`select value from platform_settings where key = ${key}`))[0]?.value;
  const newKey = normalizedEmailKey(user.email);
  if (!pending?.oldKey || !newKey || pending.newKey !== newKey) return;
  await carryEmailSuppression(db, pending.oldKey, newKey);
  if (hasStripeApiKey()) {
    const customers = rowsOf<{ stripe_customer_id: string }>(await db.execute(sql`
      select w.stripe_customer_id from workspaces w join members m on m.workspace_id = w.id
      where m.user_id = ${user.id}::uuid and m.role in ('owner','admin') and w.stripe_customer_id is not null
    `));
    const stripe = getStripe();
    for (const customer of customers) {
      const record = await stripe.customers.retrieve(customer.stripe_customer_id);
      if (!record.deleted && normalizedEmailKey(record.email ?? "") === pending.oldKey) await stripe.customers.update(record.id, { email: user.email });
    }
  }
  await db.execute(sql`delete from platform_settings where key = ${key} and value ->> 'newKey' = ${newKey}`);
}
