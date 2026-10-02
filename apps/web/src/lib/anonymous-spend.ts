import { NextResponse } from "next/server";
import { freePreview, storeAudit, turnstileFallback } from "@curvi/pipeline/seed";
import { siteUrl } from "@/lib/env";
import { clientIp, requestHostAllowed } from "@/lib/http/client-ip";
import { TURNSTILE_MESSAGE, turnstileMode, verifyTurnstile } from "@/lib/turnstile";

/** Development keeps normal fixture limits; unprotected production gets
 * the stricter seeded caps using the same counters as protected requests. */
export function anonymousSpendLimits() {
  return process.env.NODE_ENV === "production" && turnstileMode() === "fallback"
    ? turnstileFallback
    : {
      previewPerIpPerDay: freePreview.perIpPerDay,
      previewSitePerDay: freePreview.sitePerDay,
      storeAuditsPerIpPerHour: storeAudit.auditsPerIpPerHour,
      storeAuditsPerDay: storeAudit.auditsPerDay,
    };
}

/** No upload processing, provider call or store fetch may precede this check. */
export async function anonymousSpendCheck(request: Request, token: unknown, action: "preview" | "store-audit"): Promise<NextResponse | null> {
  if (!requestHostAllowed(request)) return NextResponse.json({ error: "Use the configured Curvi address." }, { status: 403 });
  const mode = turnstileMode();
  if (mode === "misconfigured") return NextResponse.json({ error: TURNSTILE_MESSAGE }, { status: 503 });
  if (mode === "fallback") return null;
  const verified = await verifyTurnstile(token, { action, hostname: new URL(siteUrl()).hostname, ip: clientIp(request.headers) });
  return verified ? null : NextResponse.json({ error: TURNSTILE_MESSAGE }, { status: 403 });
}
