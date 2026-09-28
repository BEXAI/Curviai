/**
 * GET /api/jobs/:id/compliance
 * The pack's compliance report as plain spoken rows for the pack page: per
 * file, what was checked, what was measured and what the channel requires.
 * Workspace scoped through the caller's membership. A job that is not
 * finished, or whose report is not stored, answers 200 with available false
 * and a notice, so the page can say why.
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This job does not exist in your workspace.";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to see the compliance report.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const report = await services.getComplianceReport(resolved.workspace.id, id);
  if (!report) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
