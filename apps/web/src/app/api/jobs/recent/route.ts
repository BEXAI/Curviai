/**
 * GET /api/jobs/recent
 * The workspace's most recent packs with their status, newest first, for the
 * in app "pack ready" notice: it learns which packs are running from here and
 * then follows each one on GET /api/jobs/[id], like the progress board. Read
 * only. Signed out is a 401; a workspace that could not be set up is a
 * retryable 503.
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";

export const dynamic = "force-dynamic";

/** Packs listed; the notice only needs the ones still running. */
const RECENT_LIMIT = 10;

export async function GET(): Promise<NextResponse> {
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to view jobs.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const jobs = await services.listRecentJobs(resolved.workspace.id, RECENT_LIMIT);
  return NextResponse.json(
    { jobs: jobs.map((j) => ({ id: j.id, productTitle: j.productTitle, status: j.status })) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
