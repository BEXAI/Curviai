/**
 * GET /api/offer
 * Public: the founding member banner (docs/phases/PHASE_18.md P18-21), as
 * { "founding": null } or { "founding": { code, annualCode, monthlyUsd,
 * annualUsd, seats, left, endsOn } }. No reason, no Stripe ids. The banner
 * (components/marketing/founding-offer-banner.tsx) reads it in the browser,
 * so /pricing and the home page stay static. Browsers cache it for the
 * seeded max age and the server caches its answer per process
 * (lib/offer/founding.ts), so Stripe is read at most once per few minutes
 * per process whatever the traffic. It never fails: an error reads as no
 * banner.
 */

import { NextResponse } from "next/server";
import { foundingOfferBanner } from "@curvi/pipeline/seed";
import { foundingOfferStatus } from "@/lib/offer/founding";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const result = await foundingOfferStatus();
  return NextResponse.json(
    { founding: result.show ? result.view : null },
    { headers: { "cache-control": `public, max-age=${foundingOfferBanner.statusMaxAgeSeconds}` } },
  );
}
