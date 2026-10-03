import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { CaseRefusal } from "./types";
export function caseError(error: unknown): NextResponse {
  if (error instanceof ZodError) return NextResponse.json({ error: "Check your message and remove any control characters." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (error instanceof CaseRefusal) return NextResponse.json({ error: error.message, reason: error.reason }, { status: error.reason === "not_found" ? 404 : error.reason === "invalid_reference" ? 400 : 409, headers: { "Cache-Control": "no-store" } });
  // No free text, SQL errors, or operator details reach logging/analytics.
  console.error("pack_case_request_failed");
  return NextResponse.json({ error: "We could not save your case. Try again shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
