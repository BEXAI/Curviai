"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { PgCapStore } from "@curvi/trigger/cap-store";
import { sendFounderEmail } from "@curvi/trigger/spend-alerts";
import { getOperatorSession } from "@/lib/operator-session";
import { writeOpsAudit } from "@/lib/ops/audit";
import { limitByUser } from "@/lib/rate-limit";
import { getDb } from "@/lib/services/db";
import { isUuid } from "@/lib/validation/ids";

export type SecurityResult = { error?: string; notice?: string; verified?: boolean; enrollment?: { id: string; qrCode: string; secret: string } };
const FAILED = "We could not update your sign in security. Please try again.";
async function session() {
  const current = await getOperatorSession();
  if (!current) notFound();
  return current;
}
async function limited(userId: string) { return Boolean(await limitByUser("ops.prospects", `mfa:${userId}`)); }
async function audit(email: string, action: string, factorId: string | null) {
  await writeOpsAudit(getDb(), { operatorEmail: email, action, targetKind: "auth_factor", targetId: factorId });
}
async function notify(email: string, factorId: string, change: "added" | "removed") {
  const store = new PgCapStore(getDb());
  const key = `ops:mfa:${change}:${factorId}`;
  if (!await store.claim(key)) return;
  const result = await sendFounderEmail({ subject: "Operator sign in security changed", text: `A sign in factor was ${change} ${change === "added" ? "to" : "from"} the operator account ${email}.` });
  if (!result.ok) { await store.release(key); console.error("operator_factor_notification_failed"); }
}

/** Only the first enrollment can start with a password-only session. */
export async function enrollOperatorFactor(): Promise<SecurityResult> {
  const current = await session();
  if (current.hasVerifiedFactor && current.aal !== "aal2") return { error: "Verify your existing authenticator before adding another." };
  if (await limited(current.user.id)) return { error: "Please wait before trying again." };
  try {
    await audit(current.user.email!, "mfa.enroll_requested", null);
    const { data, error } = await current.supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Curvi operator ${Date.now()}` });
    if (error || !data) return { error: FAILED };
    await audit(current.user.email!, "mfa.enrolled_unverified", data.id);
    return { enrollment: { id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret } };
  } catch { return { error: FAILED }; }
}

/** The factor is selected from the verified account, not trusted from the form. */
export async function verifyOperatorFactor(factorId: string, code: string): Promise<SecurityResult> {
  const current = await session();
  if (!isUuid(factorId) || !/^\d{6}$/.test(code)) return { error: "Enter the six digit code from your authenticator." };
  const factor = current.user.factors?.find((item) => item.id === factorId && item.factor_type === "totp");
  if (!factor) return { error: FAILED };
  const adding = factor.status !== "verified";
  if (adding && current.hasVerifiedFactor && current.aal !== "aal2") return { error: "Verify your existing authenticator before adding another." };
  if (await limited(current.user.id)) return { error: "Please wait before trying again." };
  try {
    if (adding) await audit(current.user.email!, "mfa.verify_requested", factorId);
    const challenge = await current.supabase.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) return { error: FAILED };
    const result = await current.supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    if (result.error) return { error: "That code did not work. Use the current code from your authenticator." };
    const verified = await current.supabase.auth.getClaims();
    if (verified.error || verified.data?.claims.sub !== current.user.id || verified.data.claims.aal !== "aal2") return { error: FAILED };
    if (adding) {
      await audit(current.user.email!, "mfa.factor_added", factorId);
      await notify(current.user.email!, factorId, "added");
    }
    revalidatePath("/app/ops", "layout");
    return { verified: true, notice: "Your authenticator is verified." };
  } catch { return { error: FAILED }; }
}

export async function removeOperatorFactor(factorId: string): Promise<SecurityResult> {
  const current = await session();
  if (current.hasVerifiedFactor && current.aal !== "aal2") return { error: "Verify your authenticator before removing a factor." };
  if (!isUuid(factorId) || !current.user.factors?.some((factor) => factor.id === factorId)) return { error: FAILED };
  if (await limited(current.user.id)) return { error: "Please wait before trying again." };
  try {
    await audit(current.user.email!, "mfa.remove_requested", factorId);
    const { error } = await current.supabase.auth.mfa.unenroll({ factorId });
    if (error) return { error: FAILED };
    await audit(current.user.email!, "mfa.factor_removed", factorId);
    await notify(current.user.email!, factorId, "removed");
    revalidatePath("/app/ops", "layout");
    return { notice: "The authenticator was removed." };
  } catch { return { error: FAILED }; }
}
