/**
 * Worker side guard for R2 object keys (Update.md 4.1). The worker reads
 * source photos with owner credentials, so every key it loads is checked
 * against the job's own workspace prefix first. Rows written before
 * migration 0011 were never scanned by its NOT VALID constraints, and a
 * planner can name any string, so a key outside ws/{workspaceId}/ (another
 * tenant's photo, a traversal) is never loaded. Mirrors the web app's
 * isWorkspaceObjectKey in apps/web/src/lib/object-keys.ts.
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

/** Temporary storage is isolated from source and delivered-file guards. */
export function isWorkspaceTmpKey(workspaceId: string, key: string | null | undefined): key is string {
  return typeof key === "string" && workspaceId.length > 0 &&
    key.startsWith(`tmp/ws/${workspaceId}/`) && !key.includes("..") && !key.includes("\\");
}
