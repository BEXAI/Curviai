/**
 * The operator gate for the prospect routes (docs/phases/PHASE_18.md P18-04,
 * founder decision 15): a signed in user whose confirmed email is in
 * OPS_EMAILS (lib/ops.ts isOperator). Everyone else, signed in or not, gets
 * a 404, so the routes do not show that they exist. Prospect packs need the
 * database (pack_claims, the share pages), so db mode is required too.
 * Server only.
 */

import { NextResponse } from "next/server";
import type { Db } from "@curvi/db";
import { resolveSignedIn } from "@/lib/http/services";
import { getOperatorSession } from "@/lib/operator-session";
import { isDbMode, type Services, type WorkspaceSummary } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { PROSPECT_PAGE_COPY } from "./copy";

export interface OperatorContext {
  db: Db;
  services: Services;
  workspace: WorkspaceSummary;
  userId: string;
}

export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/** The operator's own workspace and the owner connection, or the response
 * to send instead: 404 for anyone who is not an operator, 503 without db
 * mode. */
export async function resolveOperator(): Promise<OperatorContext | { response: NextResponse }> {
  const session = await getOperatorSession();
  if (!session) {
    return { response: notFoundResponse() };
  }
  if (session.aal !== "aal2") {
    return { response: NextResponse.json({ error: "Verify your authenticator in operator security first." }, { status: 403 }) };
  }
  const { user } = session;
  if (!isDbMode()) {
    return { response: NextResponse.json({ error: PROSPECT_PAGE_COPY.needsDatabase }, { status: 503 }) };
  }
  const resolved = await resolveSignedIn("Sign in first.", { ensure: true });
  if ("response" in resolved) {
    return resolved;
  }
  return { db: getDb(), services: resolved.services, workspace: resolved.workspace, userId: user.id };
}
