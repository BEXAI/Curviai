import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runProviderCanaryNow } from "@/lib/provider-canary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") return NextResponse.json({ error: "Scheduled jobs are not configured on this server." }, { status: 503, headers });
  if (auth === "denied") return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  try {
    return NextResponse.json(await runProviderCanaryNow(), { headers });
  } catch {
    return NextResponse.json({ error: "The provider check could not record its result." }, { status: 500, headers });
  }
}
