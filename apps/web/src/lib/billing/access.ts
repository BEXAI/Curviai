/**
 * Who may change billing. Plan 4.3: the client role reads assets but cannot
 * generate or bill. Billing belongs to owners and admins only (P20-59).
 */

import type { WorkspaceRole } from "@/lib/services/types";

export function canManageBilling(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export const BILLING_FORBIDDEN_NOTICE = "Only the workspace owner or an admin can change billing.";
