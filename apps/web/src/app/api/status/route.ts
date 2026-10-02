/**
 * GET /api/status
 * Public: whether a visitor can start a pack right now (docs/phases/
 * PHASE_18.md P18-03). The answer is only { "acquisition": "open" } or
 * { "acquisition": "waitlist" }: no provider names, balances or reasons.
 * The marketing calls to action (AcquisitionCta) read it in the browser, so
 * static pages stay static. Browsers cache it for the seeded max age, and
 * the gate behind it is cached per process (lib/acquisition.ts), so the
 * route costs at most a few database reads per 30 seconds whatever the
 * traffic. It never fails: an error reads as open.
 */

import { NextResponse } from "next/server";
import { acquisitionGate } from "@curvi/pipeline/seed";
import { acquisitionStatus } from "@/lib/acquisition";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const { state } = await acquisitionStatus();
  return NextResponse.json(
    { acquisition: state },
    { headers: { "cache-control": `public, max-age=${acquisitionGate.statusMaxAgeSeconds}` } },
  );
}
