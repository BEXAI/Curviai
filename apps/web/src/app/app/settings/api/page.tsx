import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { ApiKeysPanel } from "@/components/app/api-keys-panel";
import { listApiKeys } from "@/lib/api-keys/manage";
import { sessionApiKeyManager } from "@/lib/api-keys/session";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

/** /app/settings/api (PHASE_16 workstream 5): workspace API keys for the
 * Curvi API, the MCP server and the CLI. Growth plan and up; owners and
 * admins only. */
export default async function ApiKeysPage() {
  const session = await sessionApiKeyManager();
  if (!session.ok) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">{session.notice}</h1>
      </div>
    );
  }
  const listed = await listApiKeys(session.store, session.manager);

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link href="/app/settings" className="text-sm text-ink-500 underline">
          Settings
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-950">API keys</h1>
        <p className="mt-1 text-sm text-ink-500">
          Keys let the Curvi API, the MCP server and the curvi command line start packs for {session.workspaceName}. A key
          acts as the member who made it and holds credits the same way the new pack form does.
        </p>
      </div>

      <Card data-testid="api-keys">
        <CardHeader>
          <CardTitle>Your keys</CardTitle>
        </CardHeader>
        <CardContent>
          {listed.ok ? (
            <ApiKeysPanel initialKeys={listed.keys} />
          ) : (
            <div className="space-y-3" data-testid="api-keys-refused">
              <p className="text-sm text-ink-700">{listed.notice}</p>
              {listed.reason === "upgrade_required" ? (
                <Link href="/app/billing" className={buttonVariants({ size: "sm" })}>
                  See plans
                </Link>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Use a key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-700">
          <p>
            Send the key as <code>Authorization: Bearer</code> followed by the key. The API is described in{" "}
            <a href="/api/v1/openapi.json" className="font-medium text-ink-900 underline">
              the OpenAPI document
            </a>
            .
          </p>
          <p>
            To use Curvi from an AI agent, add the MCP server at <code>/api/mcp</code> on this site with the same
            header. It offers create_pack, get_pack, check_main_image and list_channels.
          </p>
          <p>File links the API returns work for 15 minutes. Revoke a key here and every call made with it stops at once.</p>
        </CardContent>
      </Card>
    </div>
  );
}
