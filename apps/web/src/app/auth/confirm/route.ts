import { createHash } from "node:crypto";
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

// The site's night canvas, raised card and wine call to action, inline so
// the page needs no other request. The CSP allows exactly this stylesheet.
const STYLE = `*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#07080d radial-gradient(ellipse at top,rgba(139,92,246,.14),transparent 60%);color:#f7f8fa;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;-webkit-font-smoothing:antialiased}main{width:100%;max-width:420px;padding:32px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(255,255,255,.035);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 8px 30px -12px rgba(0,0,0,.5)}img{display:block;height:32px;width:auto;margin:0 0 28px}h1{margin:0 0 8px;font-size:24px;line-height:1.25;letter-spacing:-.01em}p{margin:0;color:#adb8c9}form{margin:28px 0 0}button{width:100%;padding:12px 20px;border:0;border-radius:10px;background:#7a1f3d;color:#fff;font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;box-shadow:0 8px 24px -10px rgba(122,31,61,.7),inset 0 1px 0 rgba(255,255,255,.18)}button:hover{background:#8f2749}button:focus-visible{outline:2px solid #d0587a;outline-offset:2px}.links{margin-top:24px;font-size:14px}.links a{color:#c7cfdb}.links a:hover{color:#fff}.help{margin-top:8px;font-size:13px;color:#8e9db4}`;
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** What the page says for each link type; anything else reads as a signup. */
const COPY: Record<string, { title: string; text: string; button: string }> = {
  email: { title: "Confirm your email", text: "One more step. Confirm your email to finish signing up and open Curvi.", button: "Confirm my email" },
  recovery: { title: "Reset your password", text: "Continue to choose a new password for your Curvi account.", button: "Continue" },
  email_change: { title: "Confirm your new email", text: "Confirm this address to finish changing the email on your Curvi account.", button: "Confirm my new email" },
};

/** A prefetching email scanner can fetch this page without using the token. */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const copy = COPY[params.get("type") ?? ""] ?? COPY.email;
  const fields = ["token_hash", "type", "next"].map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name)?.slice(0, 8192) ?? "")}">`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${copy.title} | Curvi</title><style>${STYLE}</style></head><body><main><img src="/brand/curvi-wordmark.png" alt="Curvi" width="518" height="160"><h1>${copy.title}</h1><p>${copy.text}</p><form method="post" action="/auth/confirm">${fields}<button type="submit">${copy.button}</button></form><p class="links"><a href="/login">Back to sign in</a></p><p class="help">Questions? Write to support@curvi.ai.</p></main></body></html>`, {
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` },
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
