/**
 * Shared workspace resolution for API routes: a signed out caller gets 401,
 * and a signed in user whose workspace could not be provisioned gets a
 * retryable 503 instead of a misleading "Sign in" (Update.md 6.8).
 */

import { NextResponse } from "next/server";
import { PROVISIONING_ERROR_MESSAGE, ProvisioningError } from "./db";
import type { Services, WorkspaceSummary } from "./types";

export type WorkspaceResolution = { workspace: WorkspaceSummary } | { response: NextResponse };

export async function resolveWorkspace(services: Services, signedOutMessage: string): Promise<WorkspaceResolution> {
  try {
    const workspace = await services.getCurrentWorkspace();
    if (!workspace) {
      return { response: NextResponse.json({ error: signedOutMessage }, { status: 401 }) };
    }
    return { workspace };
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        response: NextResponse.json({ error: PROVISIONING_ERROR_MESSAGE }, { status: 503, headers: { "Retry-After": "60" } }),
      };
    }
    throw err;
  }
}
