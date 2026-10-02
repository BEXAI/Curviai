/**
 * The signed in member as a Connected apps viewer, for
 * /app/settings/connections and its action (PHASE_19 P19-10): the session's
 * workspace and role, the member's user id and the backend the connections
 * live in. In demo mode the viewer is the demo owner, as on every /app page.
 */

import { DEMO_OWNER_ID } from "@/lib/api-keys/backend";
import { getServices, isDbMode } from "@/lib/services";
import { getSessionUser } from "@/lib/supabase/server";
import type { ConnectedAppsViewer } from "./connected-apps";
import { getConsentBackend, type ConsentBackend } from "./consent-backend";
import { CONNECTED_APPS_COPY } from "./consent-copy";

export type ConnectedAppsSession =
  | { ok: true; viewer: ConnectedAppsViewer; backend: ConsentBackend; workspaceName: string; memberLabels: Map<string, string> }
  | { ok: false; notice: string };

export async function connectedAppsSession(): Promise<ConnectedAppsSession> {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, notice: CONNECTED_APPS_COPY.signIn };
  }
  const demo = !isDbMode();
  const userId = demo ? DEMO_OWNER_ID : ((await getSessionUser())?.id ?? null);
  if (!userId) {
    return { ok: false, notice: CONNECTED_APPS_COPY.signIn };
  }
  const members = await services.listMembers(workspace.id);
  return {
    ok: true,
    viewer: { userId, workspaceId: workspace.id, role: workspace.role },
    backend: getConsentBackend({ demoPerson: "owner" }),
    workspaceName: workspace.name,
    memberLabels: new Map(members.map((member) => [member.id, member.label])),
  };
}
