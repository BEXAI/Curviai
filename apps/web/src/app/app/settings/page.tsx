import type { Metadata } from "next";
import { Badge, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to see settings</h1>
      </div>
    );
  }
  const [members, integrations] = await Promise.all([
    services.listMembers(workspace.id),
    services.listIntegrations(workspace.id),
  ]);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-950">Settings</h1>
        <p className="mt-1 text-sm text-ink-500">Workspace, members and integrations.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <Label htmlFor="workspace-name">Name</Label>
          <Input id="workspace-name" value={workspace.name} readOnly className="mt-1 max-w-sm bg-ink-50" />
          <p className="mt-2 text-xs text-ink-400">Renaming arrives with team management.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-ink-100">
            {members.map((member) => (
              <li key={member.id} className="flex items-center justify-between py-3">
                <span className="text-sm text-ink-900">{member.label}</span>
                <Badge variant="outline">{member.role}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-400">Invites are read only for now.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-ink-100">
            {integrations.map((integration) => (
              <li key={integration.kind} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium capitalize text-ink-900">{integration.kind}</p>
                  <p className="mt-0.5 text-xs text-ink-500">{integration.detail}</p>
                </div>
                {integration.status === "connected" ? (
                  <Badge variant="success">Connected</Badge>
                ) : (
                  <Badge variant="outline">Not connected</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
