import { NextResponse } from "next/server";
import { z } from "zod";
import { authFailureMessage } from "@/lib/auth-errors";
import { rememberEmailChange } from "@/lib/auth/email-change";
import { readJsonCapped } from "@/lib/http/json-body";
import { publicOrigin } from "@/lib/http/public-origin";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const refused = sameOriginOrRefuse(request) ?? await limitByIp(request, "support.contact");
  if (refused) return refused;
  if (!isDbMode()) return NextResponse.json({ error: "Demo mode has no account email to change." }, { status: 409 });
  const client = await createSupabaseServerClient();
  const user = client ? (await client.auth.getUser()).data.user : null;
  if (!user?.email || !user.email_confirmed_at) return NextResponse.json({ error: "Log in with a confirmed email first." }, { status: 401 });
  const limited = await limitByUser("support.contact", `email:${user.id}`);
  if (limited) return limited;
  const body = await readJsonCapped(request);
  if (!body.ok) return body.response;
  const parsed = z.object({ email: z.string().trim().email().max(254) }).safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  try {
  await rememberEmailChange(getDb(), user.id, user.email, parsed.data.email);
  const { error } = await client!.auth.updateUser({ email: parsed.data.email }, { emailRedirectTo: `${publicOrigin(request)}/auth/confirm?next=%2Fapp%2Fsettings` });
  if (error) return NextResponse.json({ error: authFailureMessage(error.code) }, { status: 400 });
  return NextResponse.json({ notice: "We sent a link to both addresses. Your email changes once you open both." });
  } catch { return NextResponse.json({ error: "We could not change your email. Please try again." }, { status: 503 }); }
}
