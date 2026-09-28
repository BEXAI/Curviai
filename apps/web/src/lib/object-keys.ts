/**
 * Read side guard for R2 object keys stored in tenant rows (Update.md 4.1).
 * Migration 0011 stops members writing these rows and checks the prefix on
 * every new write, but its constraints are NOT VALID, so rows written before
 * it are never scanned. Anything the server presigns, zips or hands to the
 * worker with owner credentials therefore re checks that the key sits under
 * the workspace's own prefix.
 */

/** True when the key sits anywhere under ws/{workspaceId}/. */
export function isWorkspaceObjectKey(workspaceId: string, key: string | null | undefined): key is string {
  return (
    typeof key === "string" &&
    workspaceId.length > 0 &&
    key.startsWith(`ws/${workspaceId}/`) &&
    !key.includes("..") &&
    !key.includes("\\")
  );
}
