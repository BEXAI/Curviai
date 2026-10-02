"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/ops/access";
import { setOperatorSwitch } from "@/lib/ops/switches";
import { grantCredits } from "@/lib/ops/grants";
import { getDb } from "@/lib/services/db";
import { resetProviderProbe } from "@curvi/trigger/provider-canary";
import { registeredCanaryProviders, runProviderCanaryNow } from "@/lib/provider-canary";
import { clearProviderPreflightCache } from "@/lib/provider-preflight";
import { writeOpsAudit } from "@/lib/ops/audit";

export async function changeSwitch(form: FormData): Promise<void> {
  const session = await requireOperator();
  await setOperatorSwitch(getDb(), { key: String(form.get("key") ?? ""), value: String(form.get("value") ?? ""),
    message: String(form.get("message") ?? ""), operator: session.user.email! });
  revalidatePath("/app/ops");
}

export async function grantWorkspaceCredits(form: FormData): Promise<void> {
  const session = await requireOperator();
  if (form.get("confirm") !== "yes") throw new Error("Confirm the credit adjustment.");
  await grantCredits(getDb(), { operator: session.user.email!, workspaceId: String(form.get("workspaceId") ?? ""),
    credits: Number(form.get("credits")), note: String(form.get("note") ?? ""), key: String(form.get("key") ?? "") });
  revalidatePath("/app/ops");
}

export async function providerAction(form: FormData): Promise<void> {
  const session = await requireOperator();
  const provider = String(form.get("provider") ?? "");
  const action = form.get("action");
  if (!registeredCanaryProviders().includes(provider) || (action !== "reset" && action !== "probe")) throw new Error("Choose a registered provider and action.");
  if (form.get("confirm") !== "yes") throw new Error("Confirm the provider action.");
  const db = getDb();
  if (action === "reset") {
    await db.transaction(async (tx) => {
      await resetProviderProbe(tx, provider);
      await writeOpsAudit(tx, { operatorEmail: session.user.email!, action: "provider.reset", targetKind: "provider", targetId: provider });
    });
    clearProviderPreflightCache();
  } else {
    await writeOpsAudit(db, { operatorEmail: session.user.email!, action: "provider.probe_requested", targetKind: "provider", targetId: provider });
    const result = await runProviderCanaryNow(provider);
    await writeOpsAudit(db, { operatorEmail: session.user.email!, action: "provider.probe_result", targetKind: "provider", targetId: provider,
      detail: { ok: result.ok, skipped: result.skipped ?? null } });
  }
  revalidatePath("/app/ops");
}
