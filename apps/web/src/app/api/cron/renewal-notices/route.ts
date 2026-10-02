import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { hasStripeApiKey } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { runRenewalNotices } from "@/lib/billing/renewal-notices";
import { getStripe } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth !== "ok") return NextResponse.json({ error: auth === "denied" ? "Unauthorized." : "This job is not configured." }, { status: auth === "denied" ? 401 : 503 });
  if (!isDbMode() || !hasStripeApiKey()) return NextResponse.json({ ok: true, skipped: "Billing is not configured." });
  try {
    const report = await runRenewalNotices({ db: getDb(), stripe: getStripe(), dryRun: new URL(request.url).searchParams.get("dryRun") === "1" });
    return NextResponse.json({ ok: report.failed === 0, ...report }, { status: report.failed ? 502 : 200, headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "The billing notices run failed." }, { status: 500 });
  }
}
