/**
 * Resend over plain fetch (founder decision 3: Resend directly, no SDK and
 * no Loops), checked against Resend's docs on 2026-10-01
 * (docs/verification.md, "Phase 18 email"):
 *
 * - POST https://api.resend.com/emails with `Authorization: Bearer`, a
 *   JSON body { from, to, subject, text, html, reply_to, headers }, and an
 *   `Idempotency-Key` header (at most 256 characters, kept 24 hours), so a
 *   retry after a crash never delivers twice. Every request needs a
 *   User-Agent. Success answers { id }; 429 is the rate limit (10 requests a
 *   second per team) and, with 5xx and no answer, is worth a retry.
 * - Webhooks are signed the Svix way: headers svix-id, svix-timestamp and
 *   svix-signature (space separated "v1,<base64>" entries); the signed
 *   content is "<id>.<timestamp>.<raw body>", HMAC SHA-256 with the secret
 *   after its whsec_ prefix, base64 decoded. Compared in constant time, and
 *   a timestamp more than five minutes off is refused.
 * - email.bounced (the receiving server rejected the email for good, with
 *   data.bounce.type), email.complained (marked as spam) and
 *   email.suppressed (Resend's own suppression list) carry data.to, an
 *   array of addresses.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailSuppressionReason } from "@curvi/db";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
export const RESEND_USER_AGENT = "curvi-lifecycle-email/1";
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResendEmail {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export type ResendSendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number | null; retryable: boolean; error: string };

const EMAIL_LIKE = /[^\s@<>"',;:]+@[^\s@<>"',;:]+/g;

/** An error text safe to store: no address, at most 300 characters. */
export function safeErrorText(value: string): string {
  return value.replace(EMAIL_LIKE, "[address]").replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function postResendEmail(
  apiKey: string,
  email: ResendEmail,
  options: { idempotencyKey: string; timeoutMs: number; fetchImpl?: FetchLike },
): Promise<ResendSendResult> {
  const body: Record<string, unknown> = {
    from: email.from,
    to: [email.to],
    subject: email.subject,
    text: email.text,
    html: email.html,
  };
  if (email.replyTo) {
    body.reply_to = email.replyTo;
  }
  if (Object.keys(email.headers).length > 0) {
    body.headers = email.headers;
  }
  try {
    const res = await (options.fetchImpl ?? fetch)(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": RESEND_USER_AGENT,
        "Idempotency-Key": options.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        error: safeErrorText(`Resend answered ${res.status}. ${text}`),
      };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: unknown };
    return { ok: true, id: typeof data.id === "string" ? data.id.slice(0, 100) : null };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, status: null, retryable: true, error: safeErrorText(`Resend could not be reached. ${message}`) };
  }
}

export interface ResendWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** True when the body was signed with this secret within the tolerance. */
export function verifyResendWebhook(
  secret: string,
  headers: ResendWebhookHeaders,
  rawBody: string,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > RESEND_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  if (key.length === 0) {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest();
  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) {
      return false;
    }
    const presented = Buffer.from(value, "base64");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
}

export interface ResendEvent {
  type: string;
  recipients: string[];
  bounceType: string | null;
}

/** The parts of a webhook body this app reads, or null when it is not one. */
export function parseResendEvent(rawBody: string): ResendEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const event = parsed as { type?: unknown; data?: { to?: unknown; bounce?: { type?: unknown } } };
  if (typeof event.type !== "string") {
    return null;
  }
  const to = event.data?.to;
  const recipients = (Array.isArray(to) ? to : typeof to === "string" ? [to] : []).filter(
    (value): value is string => typeof value === "string" && value.length <= 320,
  );
  const bounceType = typeof event.data?.bounce?.type === "string" ? event.data.bounce.type : null;
  return { type: event.type, recipients: recipients.slice(0, 50), bounceType };
}

/** The suppression a webhook event calls for: every email stops after a
 * permanent bounce, a spam complaint or Resend's own suppression. */
export function suppressionForEvent(event: ResendEvent): { scope: "all"; reason: EmailSuppressionReason } | null {
  switch (event.type) {
    case "email.bounced":
      // Resend sends email.bounced for permanent rejections; a transient one is not a reason to stop.
      return event.bounceType && event.bounceType.toLowerCase() === "transient" ? null : { scope: "all", reason: "bounced" };
    case "email.suppressed":
      return { scope: "all", reason: "bounced" };
    case "email.complained":
      return { scope: "all", reason: "complained" };
    default:
      return null;
  }
}
