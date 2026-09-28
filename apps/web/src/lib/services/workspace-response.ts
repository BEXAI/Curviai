/**
 * Shared workspace resolution for API routes: a signed out caller gets 401,
 * and a signed in user whose workspace could not be provisioned gets a
 * retryable 503 instead of a misleading "Sign in" (Update.md 6.8).
 */

import { NextResponse } from "next/server";
import { PROVISIONING_ERROR_MESSAGE, ProvisioningError } from "./errors";
import type { Services, WorkspaceSummary } from "./types";

export type WorkspaceResolution = { workspace: WorkspaceSummary } | { response: NextResponse };

/** Seconds a client should wait before retrying a 503 from these routes. */
export const RETRY_AFTER_SECONDS = "60";

export interface ResolveWorkspaceOptions {
  /** Use ensureWorkspace, which bootstraps a workspace for a signed in user
   * who has none yet. Routes that start work (a pack, an upload) set it. */
  ensure?: boolean;
}

export async function resolveWorkspace(
  services: Services,
  signedOutMessage: string,
  options: ResolveWorkspaceOptions = {},
): Promise<WorkspaceResolution> {
  try {
    const workspace = options.ensure ? await services.ensureWorkspace() : await services.getCurrentWorkspace();
    if (!workspace) {
      return { response: NextResponse.json({ error: signedOutMessage }, { status: 401 }) };
    }
    return { workspace };
  } catch (err) {
    if (err instanceof ProvisioningError) {
      return {
        response: NextResponse.json(
          { error: PROVISIONING_ERROR_MESSAGE },
          { status: 503, headers: { "Retry-After": RETRY_AFTER_SECONDS } },
        ),
      };
    }
    throw err;
  }
}
