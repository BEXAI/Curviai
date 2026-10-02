import { notFound } from "next/navigation";
import { getOperatorSession } from "@/lib/operator-session";
import { OperatorSecurityForm } from "./security-form";
export const dynamic = "force-dynamic";
export default async function OperatorSecurityPage() {
  const current = await getOperatorSession();
  if (!current) notFound();
  const factors = (current.user.factors ?? []).filter((factor) => factor.factor_type === "totp").map((factor) => ({ id: factor.id, label: factor.friendly_name ?? "Authenticator", status: factor.status }));
  return <div className="space-y-6"><h1 className="text-3xl font-semibold">Operator sign in security</h1><OperatorSecurityForm aal={current.aal} factors={factors} /><section className="max-w-xl rounded-lg border p-4"><h2 className="font-semibold">Lost your authenticator?</h2><p className="mt-2 text-sm text-ink-600">Use another enrolled authenticator if you have one. If all factors are lost, account recovery requires the Supabase project administrator to verify your identity and remove the lost factor using the recovery runbook. Signing in with your password alone cannot remove it here.</p></section></div>;
}
