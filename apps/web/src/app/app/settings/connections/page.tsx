import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@curvi/ui";
import { ConnectedAppsPanel } from "@/components/app/connected-apps-panel";
import { listConnectedApps, type ConnectedAppView } from "@/lib/mcp-auth/connected-apps";
import { connectedAppsSession } from "@/lib/mcp-auth/connected-apps-session";
import { CONNECTED_APPS_COPY } from "@/lib/mcp-auth/consent-copy";

export const metadata: Metadata = { title: CONNECTED_APPS_COPY.title };
export const dynamic = "force-dynamic";

/** /app/settings/connections (PHASE_19 P19-10): the assistants, such as
 * ChatGPT, that can use the member's workspaces, with Disconnect. */
export default async function ConnectedAppsPage() {
  const session = await connectedAppsSession();
  if (!session.ok) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">{session.notice}</h1>
      </div>
    );
  }
  let apps: ConnectedAppView[] | null = null;
  try {
    apps = await listConnectedApps(session.backend, session.viewer, session.memberLabels);
  } catch (err) {
    console.error("[connected-apps] could not list connections", err instanceof Error ? err.name : "error");
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link href="/app/settings" className="text-sm text-ink-500 underline">
          Settings
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-950">{CONNECTED_APPS_COPY.title}</h1>
        <p className="mt-1 text-sm text-ink-500">{CONNECTED_APPS_COPY.intro}</p>
      </div>
      <Card data-testid="connected-apps">
        <CardContent className="pt-6">
          {apps ? (
            <ConnectedAppsPanel initialApps={apps} />
          ) : (
            <p className="text-sm text-ink-700">{CONNECTED_APPS_COPY.unavailable}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
