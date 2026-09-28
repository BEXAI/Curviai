/**
 * Who may change billing. Plan 4.3: the client role reads assets but cannot
 * generate or bill. Owners, admins and editors can.
 */

import type { WorkspaceRole } from "@/lib/services/types";

export function canManageBilling(role: WorkspaceRole): boolean {
  return role !== "client";
}

export const BILLING_FORBIDDEN_NOTICE = "Client seats cannot change billing. Ask the workspace owner.";
