"use server";

import { revalidatePath } from "next/cache";
import { disconnectConnectedApp, type DisconnectResult } from "@/lib/mcp-auth/connected-apps";
import { connectedAppsSession } from "@/lib/mcp-auth/connected-apps-session";

/** Disconnect on Settings, Connected apps (PHASE_19 P19-10). Your own
 * connection, or, for owners and admins, a member's connection in a
 * workspace you manage. */
export async function disconnectConnectionAction(connectionId: string): Promise<DisconnectResult> {
  const session = await connectedAppsSession();
  if (!session.ok) {
    return { ok: false, notice: session.notice };
  }
  const result = await disconnectConnectedApp(session.backend, session.viewer, connectionId);
  if (result.ok) {
    revalidatePath("/app/settings/connections");
  }
  return result;
}
