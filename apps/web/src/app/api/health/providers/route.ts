/**
 * GET /api/health/providers
 * Reports configured providers and circuit breaker states from the
 * injectable health registry. Safe with zero env configured.
 */

import { NextResponse } from "next/server";
import { getHealthRegistry } from "@/lib/health";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const report = await getHealthRegistry().report(isDbMode() ? "db" : "demo");
  return NextResponse.json(report);
}
