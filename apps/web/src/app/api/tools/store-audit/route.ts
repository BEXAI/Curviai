/**
 * POST /api/tools/store-audit
 * The free store image audit (docs/phases/PHASE_18.md P18-18): reads a
 * Shopify store's public product list and checks each product's first image
 * against one checker channel. No sign in. The server fetches addresses a
 * stranger typed, so:
 * - it answers 404 while the store_audit_enabled switch is off (seeded off);
 * - a cross site Origin is refused and the body is capped before parsing;
 * - an address is checked before any network work (lib/store-audit/parse.ts),
 *   so a typo costs no quota and makes no fetch;
 * - each IP may run storeAudit.auditsPerIpPerHour audits an hour, the site
 *   storeAudit.auditsPerDay a day, and one process storeAudit.concurrentAudits
 *   at once (growth.ts);
 * - every fetch goes through the SSRF safe fetch and the photo import's
 *   guards, inside one audit deadline (lib/store-audit/audit.ts).
 * Nothing is stored; a completed audit writes the funnel.store_audit_run
 * event with counts only, never the store's address.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFunnelEvent } from "@curvi/db";
import { storeAudit } from "@curvi/pipeline/seed";
import { anonymousSpendCheck, anonymousSpendLimits } from "@/lib/anonymous-spend";
import { storeAuditErrors, type StoreAuditErrorReason } from "@/components/marketing/search-copy";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { checkRateLimit, clientIp, rateLimitedResponse } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { runStoreAudit } from "@/lib/store-audit/audit";
import { takeDailyAudit } from "@/lib/store-audit/daily-cap";
import { STORE_ADDRESS_MAX, parseStoreAddress } from "@/lib/store-audit/parse";
import { storeAuditEnabled } from "@/lib/store-audit/switch";
import { checkerChannelFor } from "@/lib/tools/checker-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_MAX_BYTES = 4096;

const AuditRequest = z.object({
  store: z.string().min(1).max(STORE_ADDRESS_MAX),
  channel: z.string().max(40).optional(),
  captchaToken: z.string().max(2048).optional(),
});

const ERROR_STATUS: Record<StoreAuditErrorReason, number> = {
  invalid_store: 400,
  blocked_host: 400,
  amazon: 400,
  invalid: 400,
  not_shopify: 422,
  no_products: 422,
  too_large: 422,
  store_busy: 502,
  unreachable: 502,
  timeout: 504,
  daily_cap: 429,
  busy: 503,
  off: 404,
};

function errorResponse(reason: StoreAuditErrorReason, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(
    { error: storeAuditErrors[reason], reason },
    { status: ERROR_STATUS[reason], ...(headers ? { headers } : {}) },
  );
}

const inFlight = globalThis as typeof globalThis & { __curviStoreAuditsInFlight?: number };

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await storeAuditEnabled())) {
    return errorResponse("off");
  }
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const body = await readJsonCapped(request, BODY_MAX_BYTES);
  if (!body.ok) {
    return body.response;
  }
  const parsed = AuditRequest.safeParse(body.data);
  if (!parsed.success) {
    return errorResponse("invalid_store");
  }
  const address = parseStoreAddress(parsed.data.store);
  if (!address.ok) {
    return errorResponse(address.reason);
  }
  const challenge = await anonymousSpendCheck(request, parsed.data.captchaToken, "store-audit");
  if (challenge) return challenge;

  // Take a slot before any await, so two requests cannot both pass a full
  // check; a request refused below gives it back without using any quota.
  if ((inFlight.__curviStoreAuditsInFlight ?? 0) >= storeAudit.concurrentAudits) {
    return errorResponse("busy", { "Retry-After": "60" });
  }
  inFlight.__curviStoreAuditsInFlight = (inFlight.__curviStoreAuditsInFlight ?? 0) + 1;
  const channel = checkerChannelFor(parsed.data.channel);
  let outcome;
  try {
    const ip = clientIp(request.headers);
    const limit = anonymousSpendLimits().storeAuditsPerIpPerHour;
    if (ip === "unknown" && process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "We could not check this connection. Please try again." }, { status: 429 });
    }
    if (ip !== "unknown") {
      const decision = await checkRateLimit("tools.storeAudit", "ip", `ip:${ip}`);
      if (!decision.allowed || decision.limit - decision.remaining > limit) {
        return rateLimitedResponse({ ...decision, allowed: false, limit, remaining: 0 });
      }
    }
    const daily = await takeDailyAudit();
    if (!daily.allowed) {
      return errorResponse("daily_cap", { "Retry-After": String(daily.retryAfterSeconds) });
    }
    outcome = await runStoreAudit(address.origin, channel);
  } catch (err) {
    console.error("[store-audit] audit failed", err instanceof Error ? err.message : err);
    return errorResponse("unreachable");
  } finally {
    inFlight.__curviStoreAuditsInFlight = Math.max(0, (inFlight.__curviStoreAuditsInFlight ?? 1) - 1);
  }
  if (!outcome.ok) {
    return errorResponse(outcome.reason);
  }

  if (isDbMode()) {
    const { summary } = outcome.report;
    await recordFunnelEvent(getDb(), {
      workspaceId: null,
      name: "store_audit_run",
      props: {
        channel: channel.key,
        listed: summary.listed,
        checked: summary.checked,
        failing: summary.failing,
        thin: summary.thin,
        not_checked: summary.notChecked,
      },
    });
  }
  return NextResponse.json({ audit: outcome.report }, { headers: { "Cache-Control": "no-store" } });
}
