/**
 * Service lookup for route handlers. getServices() throws
 * DemoModeRefusedError when production lost its database or Supabase env
 * vars (lib/services/demo-mode); these helpers turn that into a plain 503 so
 * a route never falls through to a shared demo workspace or a bare 500.
 */

import { NextResponse } from "next/server";
import { getServices, type Services, type WorkspaceSummary } from "@/lib/services";
import { DEMO_MODE_REFUSED_MESSAGE, DemoModeRefusedError } from "@/lib/services/demo-mode";
import {
  resolveWorkspace,
  RETRY_AFTER_SECONDS,
  type ResolveWorkspaceOptions,
} from "@/lib/services/workspace-response";

export function serviceUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: DEMO_MODE_REFUSED_MESSAGE, reason: "unavailable" },
    { status: 503, headers: { "Retry-After": RETRY_AFTER_SECONDS } },
  );
}

export function servicesOrUnavailable(): { services: Services } | { response: NextResponse } {
  try {
    return { services: getServices() };
  } catch (err) {
    if (err instanceof DemoModeRefusedError) {
      console.error("[services] refusing demo mode in production; set DATABASE_URL and the Supabase env vars");
      return { response: serviceUnavailableResponse() };
    }
    throw err;
  }
}

export type SignedInResolution = { services: Services; workspace: WorkspaceSummary } | { response: NextResponse };

/**
 * The services plus the caller's workspace: 503 when the server may not
 * serve (demo mode refused, workspace provisioning failed), 401 with
 * signedOutMessage when nobody is signed in.
 */
export async function resolveSignedIn(
  signedOutMessage: string,
  options: ResolveWorkspaceOptions = {},
): Promise<SignedInResolution> {
  const found = servicesOrUnavailable();
  if ("response" in found) {
    return found;
  }
  const resolved = await resolveWorkspace(found.services, signedOutMessage, options);
  if ("response" in resolved) {
    return resolved;
  }
  return { services: found.services, workspace: resolved.workspace };
}
