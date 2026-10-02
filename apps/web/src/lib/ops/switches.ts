import { platformSettings, eq, sql, type Db } from "@curvi/db";
import { deploy, isOpsSwitchKey, opsSwitchDefaults } from "@curvi/pipeline/seed";
import { forgetOpsSwitch } from "@/lib/features";
import { opsEmails } from "@/lib/ops";
import { writeOpsAudit } from "./audit";

export async function setOperatorSwitch(db: Db, input: { key: string; value: string; operator: string; message?: string }, now = new Date()): Promise<void> {
  if (!opsEmails().includes(input.operator.trim().toLowerCase())) throw new Error("Operator access required.");
  if (!isOpsSwitchKey(input.key)) throw new Error("Unknown operator switch.");
  const key = input.key;
  const kind = opsSwitchDefaults[key].kind;
  let value: unknown;
  if (kind === "usd") {
    value = input.value.trim() === "" ? null : Number(input.value);
    if (value !== null && (!Number.isFinite(value) || Number(value) < 0)) throw new Error("Use a nonnegative dollar amount or leave it blank for the default.");
  } else {
    if (input.value !== "true" && input.value !== "false") throw new Error("Choose on or off.");
    const on = input.value === "true";
    value = kind === "boolean" ? on : { on, message: input.message?.trim().slice(0, 200) || undefined,
      setBy: input.operator, setAt: now.toISOString(),
      ...(key === "ops:deploy_pending" && on ? { expiresAt: new Date(now.getTime() + deploy.pendingMaxMinutes * 60000).toISOString() } : {}) };
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ops:switch:${key}`},0))`);
    const old = await tx.query.platformSettings.findFirst({ where: eq(platformSettings.key, key) });
    await tx.insert(platformSettings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: now } });
    await writeOpsAudit(tx, { operatorEmail: input.operator, action: "switch.set", targetKind: "platform_setting", targetId: key,
      detail: { before: old?.value ?? null, after: value } }, now);
  });
  forgetOpsSwitch(key);
}
