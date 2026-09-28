/**
 * POST /api/csp-report
 * Receives Content Security Policy violation reports from the report only
 * policy in next.config.ts (report-uri and report-to both point here) and
 * logs each one as a structured line (lib/csp-report.ts). Browsers send these
 * without credentials and ignore the response, so it always answers 204
 * unless the body is too large or not a report.
 */

import { readBodyLimited } from "@/lib/http/read-body";
import { NextResponse, type NextRequest } from "next/server";
import {
  CSP_REPORT_MAX_BYTES,
  isCspReportContentType,
  parseCspReports,
  ReportLogBudget,
} from "@/lib/csp-report";

export const dynamic = "force-dynamic";

const globalScope = globalThis as typeof globalThis & { __curviCspBudget?: ReportLogBudget };

function budget(): ReportLogBudget {
  globalScope.__curviCspBudget ??= new ReportLogBudget();
  return globalScope.__curviCspBudget;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isCspReportContentType(request.headers.get("content-type"))) {
    return new NextResponse(null, { status: 415 });
  }
  const body = await readBodyLimited(request, CSP_REPORT_MAX_BYTES);
  if (!body.ok && body.reason === "too_large") {
    return new NextResponse(null, { status: 413 });
  }
  const raw = body.ok ? body.text : "";
  const violations = parseCspReports(raw);
  const { allowed, droppedBefore } = budget().take(violations.length);
  if (droppedBefore > 0) {
    console.warn(JSON.stringify({ level: "warn", event: "csp_reports_dropped", count: droppedBefore }));
  }
  for (const violation of violations.slice(0, allowed)) {
    console.warn(JSON.stringify({ level: "warn", event: "csp_violation", ...violation }));
  }
  return new NextResponse(null, { status: 204 });
}
