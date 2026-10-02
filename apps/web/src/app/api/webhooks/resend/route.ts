/**
 * POST /api/webhooks/resend (docs/phases/PHASE_18.md P18-06)
 * Resend's email events, signed the Svix way with RESEND_WEBHOOK_SECRET
 * (whsec_...; packages/email/src/resend.ts verifies the svix-id,
 * svix-timestamp and svix-signature headers over the raw body, constant
 * time, within five minutes). A hard bounce (email.bounced), a spam
 * complaint (email.complained) and Resend's own suppression
 * (email.suppressed) stop all email to each address in data.to; every other
 * event is acknowledged and ignored. Only the sha256 key of an address is
 * stored, and no address is logged.
 *
 * 503 while RESEND_WEBHOOK_SECRET is unset (until then the founder reviews
 * bounces in Resend), 401 for a bad signature, 413 for an oversized body,
 * 500 when the list cannot be written, so Resend retries.
 */

import { NextResponse } from "next/server";
import { normalizedEmailKey, parseResendEvent, suppressionForEvent, verifyResendWebhook } from "@curvi/email";
import { getSuppressionStore } from "@/lib/email/preferences";
import { optionalEnv } from "@/lib/env";
import { readBodyLimited, WEBHOOK_MAX_BYTES } from "@/lib/http/read-body";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = optionalEnv("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json(
      { error: "resend_webhook_not_configured", notice: "Set RESEND_WEBHOOK_SECRET to receive Resend email events." },
      { status: 503 },
    );
  }
  const read = await readBodyLimited(request, WEBHOOK_MAX_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: "The body is too large or unreadable." }, { status: read.reason === "too_large" ? 413 : 400 });
  }
  const verified = verifyResendWebhook(
    secret,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    read.text,
  );
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const event = parseResendEvent(read.text);
  if (!event) {
    return NextResponse.json({ ok: true, ignored: "not an email event" });
  }
  const suppression = suppressionForEvent(event);
  if (!suppression) {
    return NextResponse.json({ ok: true, ignored: event.type });
  }
  const keys = [...new Set(event.recipients.map((to) => normalizedEmailKey(to)).filter((key): key is string => key !== null))];
  try {
    const store = getSuppressionStore();
    for (const key of keys) {
      await store.add(key, suppression.scope, suppression.reason);
    }
  } catch (err) {
    console.error(`[email] could not record a ${event.type} suppression`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "The suppression list could not be written." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, suppressed: keys.length, reason: suppression.reason });
}
