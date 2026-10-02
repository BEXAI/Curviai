import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { runRetention } from "@/lib/ops/retention";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth !== "ok") return NextResponse.json({ error: "Not authorized or configured." }, { status: auth === "denied" ? 401 : 503 });
  if (!isDbMode()) return NextResponse.json({ ok: true, skipped: "No database." });
  try {
    const db = getDb();
    const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
    const report = await runRetention({ db, dryRun });
    if (!dryRun && !report.budgetExhausted) await recordCronSuccess(db, "retention");
    return NextResponse.json({ ok: true, report }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Retention did not finish." }, { status: 500 });
  }
}
