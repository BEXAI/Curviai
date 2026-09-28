/**
 * GET /api/jobs/:id/compliance-report.pdf
 * The pack's compliance report as a PDF download, built on request from the
 * stored JSON report (lib/compliance-pdf.ts), so it always matches what the
 * pack page shows. Workspace scoped through the caller's membership; 409
 * while the report is not available.
 */

import { NextResponse } from "next/server";
import { renderComplianceReportPdf } from "@/lib/compliance-pdf";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This job does not exist in your workspace.";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to download the compliance report.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const report = await services.getComplianceReport(resolved.workspace.id, id);
  if (!report) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  if (!report.available) {
    return NextResponse.json({ error: report.notice ?? "The compliance report is not available yet." }, { status: 409 });
  }
  const pdf = renderComplianceReportPdf(report);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="compliance-report.pdf"',
      "content-length": String(pdf.length),
      "cache-control": "no-store",
    },
  });
}
