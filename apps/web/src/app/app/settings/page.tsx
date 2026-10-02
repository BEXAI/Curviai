import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { DeleteAccountForm } from "@/components/app/delete-account-form";
import { ChangeEmailCard } from "@/components/app/change-email-card";
import { EmailPreferencesForm } from "@/components/app/email-preferences-form";
import { WorkspaceNameForm } from "@/components/app/workspace-name-form";
import { referralOfferText, REFERRALS_SETTINGS_LINK } from "@/components/app/referral-copy";
import { EMAIL_SETTINGS_TITLE } from "@/lib/email/copy";
import { marketingAllowed } from "@/lib/email/preferences";
import { CONNECTED_APPS_COPY } from "@/lib/mcp-auth/consent-copy";
import { referralsOn } from "@/lib/referrals/switch";
import { getServices, isDbMode } from "@/lib/services";
import { getSessionUser } from "@/lib/supabase/server";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { uploadRetentionSummary } from "@/lib/legal/retention";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to see settings</h1>
      </div>
    );
  }
  const [members, integrations, user] = await Promise.all([
    services.listMembers(workspace.id),
    services.listIntegrations(workspace.id),
    getSessionUser(),
  ]);
  // P18-06: whether this address gets tips and offers (a read failure shows it as off).
  const marketingOn = user ? await marketingAllowed(user.email).catch(() => false) : false;
  // P18-24: the invite card shows only while referrals are on.
  const canInvite = (workspace.role === "owner" || workspace.role === "admin") && isDbMode() && (await referralsOn());

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
          <WorkspaceNameForm initialName={workspace.name} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-900">{user?.email ?? "Demo session, no account"}</p>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Link href="/reset-password" className="font-medium text-ink-900 underline">
              Change password
            </Link>
            {user ? (
              <form action="/auth/signout" method="post">
                <button type="submit" className="font-medium text-ink-900 underline">
                  Sign out
                </button>
              </form>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {user ? (
        <Card data-testid="email-settings">
          <CardHeader>
            <CardTitle>{EMAIL_SETTINGS_TITLE}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmailPreferencesForm initialAllowed={marketingOn} />
          </CardContent>
        </Card>
      ) : null}

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
          <p className="mt-3 text-xs text-ink-400">
            Need another seat? <Link href="/support?topic=account" className="underline">Contact {LEGAL_FACTS.support.email}</Link> and we will help with your workspace.
          </p>
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
                  <p className="mt-0.5 text-xs text-ink-500" data-testid={`integration-${integration.kind}`}>
                    {integration.detail}
                    {integration.link ? (
                      <>
                        {" "}
                        <Link href={integration.link.href} className="font-medium text-accent-700 underline underline-offset-2">
                          {integration.link.label}
                        </Link>
                      </>
                    ) : null}
                  </p>
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

      <Card data-testid="api-keys-link">
        <CardHeader>
          <CardTitle>API keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-500">
            Start packs from your own tools, an AI agent or the command line. Growth plan and above.
          </p>
          <Link href="/app/settings/api" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Manage API keys
          </Link>
        </CardContent>
      </Card>

      <Card data-testid="connected-apps-link">
        <CardHeader>
          <CardTitle>{CONNECTED_APPS_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-ink-500">{CONNECTED_APPS_COPY.settingsCard}</p>
          <Link href="/app/settings/connections" className={buttonVariants({ variant: "outline", size: "sm" })}>
            {CONNECTED_APPS_COPY.settingsLink}
          </Link>
        </CardContent>
      </Card>

      {canInvite ? (
        <Card data-testid="referrals-link">
          <CardHeader>
            <CardTitle>{REFERRALS_SETTINGS_LINK}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-ink-500">{referralOfferText()}</p>
            <Link href="/app/settings/referrals" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {REFERRALS_SETTINGS_LINK}
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <ChangeEmailCard email={user?.email ?? null} />
      <Card data-testid="your-data">
        <CardHeader>
          <CardTitle>Your data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-900">Download your data</p>
            <p className="text-sm text-ink-500">
              One file with your products, photos, packs, file links, brand kit and credit history. The links in it
              work for 24 hours.
            </p>
            {workspace.role === "owner" || workspace.role === "admin" ? (
              <a
                href="/api/account/export"
                download
                className={buttonVariants({ variant: "outline", size: "sm" })}
                data-testid="export-data"
              >
                Download my data
              </a>
            ) : (
              <p className="text-xs text-ink-400">Ask a workspace owner to download the data.</p>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-900">How long we keep your uploads</p>
            <p className="text-sm text-ink-500" data-testid="upload-retention">
              {uploadRetentionSummary(LEGAL_FACTS)}{" "}
              <Link href="/privacy#retention" className="font-medium text-ink-900 underline">
                How long we keep everything
              </Link>
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-900">Delete account</p>
            <DeleteAccountForm disabledReason={user ? null : "Demo mode has no account to delete."} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
