/**
 * Settings, Connected apps (docs/phases/PHASE_19.md, P19-10 and
 * "Revocation"): which assistants can use the member's workspaces, and the
 * Disconnect button.
 *
 * - A member sees their own live connections in every workspace; owners and
 *   admins of the current workspace also see the other members' live
 *   connections there.
 * - Disconnecting your own: revoked_at is set first (the MCP server reads
 *   the live row on every call, so every call stops at once), then
 *   Supabase's revokeGrant with the web session, which revokes the consent
 *   and deletes that client's sessions and refresh tokens (docs/verification
 *   .md, "PHASE_19", the grants row), so a reconnect passes the consent page
 *   again. When Supabase cannot do it, the sessions are deleted over the
 *   owner connection instead.
 * - Disconnecting a member's (owners and admins of that row's workspace
 *   only, checked against today's membership): revoked_at is set and that
 *   member's sessions for the client are deleted, so their token fails the
 *   session check within its cache minute. Their consent stays, so their
 *   next connect takes the consented path, finds no live row and shows the
 *   picker.
 * - A revoked row is never made live again (connections.ts); links tied to
 *   it stop working (P19-17 checks the row on every click).
 */

import type { WorkspaceRole } from "@/lib/services/types";
import type { McpConnectionRecord } from "./connections";
import type { ConsentBackend } from "./consent-backend";
import { CONNECTED_APPS_COPY } from "./consent-copy";

export interface ConnectedAppsViewer {
  userId: string;
  /** The workspace the settings page is for. */
  workspaceId: string;
  /** The viewer's role there. */
  role: WorkspaceRole;
}

export interface ConnectedAppView {
  id: string;
  clientName: string;
  workspaceName: string;
  /** True for the viewer's own connection. */
  own: boolean;
  /** Who made it, for another member's connection. */
  memberLabel: string | null;
  /** ISO timestamps. */
  connectedAt: string;
  lastUsedAt: string | null;
}

export type DisconnectResult = { ok: true; notice: string } | { ok: false; notice: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function managesWorkspace(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin";
}

function viewOf(
  row: McpConnectionRecord,
  own: boolean,
  names: ReadonlyMap<string, string>,
  labels: ReadonlyMap<string, string>,
): ConnectedAppView {
  return {
    id: row.id,
    clientName: row.clientName || CONNECTED_APPS_COPY.defaultClientName,
    workspaceName: names.get(row.workspaceId) ?? CONNECTED_APPS_COPY.unknownWorkspace,
    own,
    memberLabel: own ? null : (labels.get(row.userId) ?? CONNECTED_APPS_COPY.someone),
    connectedAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** The viewer's own live connections, then (for owners and admins) the
 * other members' live connections in the current workspace. memberLabels
 * names the current workspace's members by user id. */
export async function listConnectedApps(
  backend: ConsentBackend,
  viewer: ConnectedAppsViewer,
  memberLabels: ReadonlyMap<string, string> = new Map(),
): Promise<ConnectedAppView[]> {
  const own = (await backend.connections.listForUser(viewer.userId)).filter((row) => !row.revokedAt);
  const others = managesWorkspace(viewer.role)
    ? (await backend.connections.listLiveInWorkspace(viewer.workspaceId)).filter((row) => row.userId !== viewer.userId)
    : [];
  const names = await backend.workspaceNames([...new Set([...own, ...others].map((row) => row.workspaceId))]);
  return [...own.map((row) => viewOf(row, true, names, memberLabels)), ...others.map((row) => viewOf(row, false, names, memberLabels))];
}

/** Disconnect on the Connected apps page. */
export async function disconnectConnectedApp(
  backend: ConsentBackend,
  viewer: ConnectedAppsViewer,
  connectionId: unknown,
  now: Date = new Date(),
): Promise<DisconnectResult> {
  if (typeof connectionId !== "string" || !UUID.test(connectionId)) {
    return { ok: false, notice: CONNECTED_APPS_COPY.alreadyDisconnected };
  }
  const row = await backend.connections.findById(connectionId);
  if (!row) {
    return { ok: false, notice: CONNECTED_APPS_COPY.alreadyDisconnected };
  }
  const own = row.userId === viewer.userId;
  if (!own && !managesWorkspace(await backend.role(viewer.userId, row.workspaceId))) {
    return { ok: false, notice: CONNECTED_APPS_COPY.notAllowed };
  }
  if (row.revokedAt) {
    return { ok: true, notice: CONNECTED_APPS_COPY.alreadyDisconnected };
  }

  await backend.connections.revoke(row.id, now);
  if (own) {
    if (!(await backend.revokeOwnGrant(row.oauthClientId))) {
      await backend.endSessions(row.userId, row.oauthClientId);
    }
  } else {
    await backend.endSessions(row.userId, row.oauthClientId);
  }
  return { ok: true, notice: CONNECTED_APPS_COPY.disconnected };
}
