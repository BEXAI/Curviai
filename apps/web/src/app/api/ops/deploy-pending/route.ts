import { NextResponse } from "next/server";
import { z } from "zod";
import { checkCronAuth } from "@/lib/cron-auth";
import { optionalEnv } from "@/lib/env";
import { readBodyLimited } from "@/lib/http/read-body";
import { opsEmails } from "@/lib/ops";
import { setOperatorSwitch } from "@/lib/ops/switches";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";
const inputSchema = z.object({ on: z.boolean(), setBy: z.string().email().max(320) }).strict();
const headers = { "cache-control": "no-store" };

/** A separate release credential can alter exactly this expiring flag. */
export async function POST(request: Request) {
  const token = optionalEnv("OPS_RELEASE_TOKEN");
  // This endpoint intentionally does not accept x-cron-secret.
  const auth = checkCronAuth(new Headers({ authorization: request.headers.get("authorization") ?? "" }), token ?? "");
  if (auth !== "ok") return NextResponse.json({ error: "Release authorization required." }, { status: auth === "unconfigured" ? 503 : 401, headers });
  const body = await readBodyLimited(request, 2048);
  if (!body.ok) return NextResponse.json({ error: "Invalid request." }, { status: body.reason === "too_large" ? 413 : 400, headers });
  let input;
  try { input = inputSchema.safeParse(JSON.parse(body.text)); } catch { input = null; }
  if (!input?.success) return NextResponse.json({ error: "Use on and setBy only." }, { status: 400, headers });
  if (!opsEmails().includes(input.data.setBy.trim().toLowerCase())) return NextResponse.json({ error: "An allowlisted operator email is required." }, { status: 403, headers });
  if (!isDbMode()) return NextResponse.json({ error: "A database is required." }, { status: 503, headers });
  try {
    await setOperatorSwitch(getDb(), { key: "ops:deploy_pending", value: String(input.data.on), operator: input.data.setBy });
    return NextResponse.json({ ok: true, on: input.data.on }, { headers });
  } catch {
    return NextResponse.json({ error: "The release flag could not be recorded." }, { status: 503, headers });
  }
}
