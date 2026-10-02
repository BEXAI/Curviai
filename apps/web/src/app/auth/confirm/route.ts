import { NextResponse, type NextRequest } from "next/server";
import { finishSignIn } from "@/lib/auth/finish";
import { confirmationTarget } from "@/lib/auth/confirm-next";
import { publicOrigin } from "@/lib/http/public-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { finishEmailChange } from "@/lib/auth/email-change";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { readBodyLimited } from "@/lib/http/read-body";

export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** A prefetching email scanner can fetch this page without using the token. */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const fields = ["token_hash", "type", "next"].map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name)?.slice(0, 8192) ?? "")}">`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm your email | Curvi</title></head><body><main><h1>Confirm your email</h1><p>Continue to finish the request you made in Curvi.</p><form method="post" action="/auth/confirm">${fields}<button type="submit">Confirm my email</button></form><p><a href="/login">Back to sign in</a></p></main></body></html>`, {
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

export async function POST(request: NextRequest) {
  const origin = publicOrigin(request);
  if (request.headers.get("origin") !== origin) return new Response("This request came from another site.", { status: 403, headers: PRIVATE_HEADERS });
  const invalid = () => NextResponse.redirect(new URL("/login?error=link_invalid", origin), { status: 303, headers: PRIVATE_HEADERS });
  const body = await readBodyLimited(request, 16384);
  if (!body.ok || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return invalid();
  const form = new URLSearchParams(body.text);
  const token = form.get("token_hash");
  const type = form.get("type");
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{16,2048}$/.test(token) || (type !== "email" && type !== "recovery" && type !== "email_change")) return invalid();
  const rawNext = form.get("next");
  const target = confirmationTarget(typeof rawNext === "string" ? rawNext : null, origin);
  const supabase = await createSupabaseServerClient();
  if (!supabase) return invalid();
  try {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: token, type });
    if (error) return invalid();
    // The first of two secure email change confirmations may return no session.
    if (type === "email_change") {
      if (data.user && isDbMode()) {
        try { await finishEmailChange(getDb(), data.user); } catch { console.error("email_change_sync_failed"); }
      }
      return NextResponse.redirect(new URL("/app/settings?email_confirmation=received", origin), { status: 303, headers: PRIVATE_HEADERS });
    }
    if (!data.user) return invalid();
    const next = type === "recovery" ? "/reset-password" : await finishSignIn({ user: data.user, next: target.next, origin, headers: request.headers, params: target.params });
    return NextResponse.redirect(new URL(next, origin), { status: 303, headers: PRIVATE_HEADERS });
  } catch { return invalid(); }
}
