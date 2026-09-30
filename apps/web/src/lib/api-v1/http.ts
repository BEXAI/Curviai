/**
 * Glue between the /api/v1 route handlers and the transport neutral actions:
 * API key authentication and ApiResult to NextResponse. The v1 routes are
 * called by servers and agents with a bearer key, never by a signed in
 * browser, so they read no session cookie and need no same origin check: a
 * cross site page has no key to send.
 */

import { NextResponse } from "next/server";
import { authenticateApiKey, type ApiAuthError, type ApiCaller } from "@/lib/api-keys/auth";
import type { ApiScope } from "@/lib/api-keys/format";
import type { ApiResult } from "./actions";

/** Body cap for requests that may carry base64 photos: up to eight photos
 * of the 25 MB cap would not fit, so large photos go by link. */
export const API_PHOTO_BODY_MAX_BYTES = 40_000_000;

export function apiResponse(result: ApiResult): NextResponse {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

export function authErrorResponse(error: ApiAuthError): NextResponse {
  const headers: Record<string, string> = {};
  if (error.status === 401) {
    headers["WWW-Authenticate"] = 'Bearer realm="curvi"';
  }
  if (error.status === 503) {
    headers["Retry-After"] = "60";
  }
  return NextResponse.json({ error: error.message, reason: error.reason }, { status: error.status, headers });
}

/** The caller behind the request's API key, or the refusal to send. */
export async function authorize(
  request: Request,
  scope: ApiScope | null,
): Promise<{ caller: ApiCaller } | { response: NextResponse }> {
  const auth = await authenticateApiKey(request.headers, scope);
  return auth.ok ? { caller: auth.caller } : { response: authErrorResponse(auth.error) };
}
