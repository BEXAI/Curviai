import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@curvi/ui";
import { ConsentForm } from "@/components/oauth/consent-form";
import { ConsentSignIn } from "@/components/oauth/consent-sign-in";
import { consentPath, loadConsent, type ConsentView } from "@/lib/mcp-auth/consent";
import { CONSENT_COPY } from "@/lib/mcp-auth/consent-copy";
import { consentBackendForRequest } from "@/lib/mcp-auth/consent-request";
import { switchAccountAction } from "./actions";

export const metadata: Metadata = {
  title: CONSENT_COPY.title,
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/**
 * https://curvi.ai/oauth/consent?authorization_id=... (PHASE_19 P19-09):
 * Supabase's OAuth server sends ChatGPT's sign in here (its authorization
 * path). The decisions are in lib/mcp-auth/consent; this page renders them.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const backend = await consentBackendForRequest();
  let view: ConsentView = { kind: "message", message: "unavailable" };
  if (backend) {
    try {
      view = await loadConsent(backend, params.authorization_id, {
        headers: await headers(),
        switched: params.switched === "1",
      });
    } catch (err) {
      console.error("[consent] the page could not load", err instanceof Error ? err.name : "error");
    }
  }
  if (view.kind === "redirect") {
    // The user consented before and ChatGPT still has a live connection.
    redirect(view.url);
  }

  return (
    <div className="space-y-6" data-testid="consent-page">
      <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950">{CONSENT_COPY.title}</h1>
      {view.kind === "signed_out" ? (
        <ConsentSignIn next={consentPath(view.authorizationId, { switched: view.switched === true })} />
      ) : view.kind === "message" ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-ink-900" data-testid="consent-message">
              {CONSENT_COPY[view.message]}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="consent-account">
              <p className="text-sm text-ink-900">{CONSENT_COPY.signedInAs(view.email)}</p>
              <form action={switchAccountAction}>
                <input type="hidden" name="authorization_id" value={view.authorizationId} />
                <button type="submit" className="text-sm font-medium text-ink-900 underline">
                  {CONSENT_COPY.useAnotherAccount}
                </button>
              </form>
            </div>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-ink-950">{CONSENT_COPY.ableHeading}</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
                {CONSENT_COPY.able.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>

            <section className="space-y-2" data-testid="consent-scopes">
              <h2 className="text-sm font-semibold text-ink-950">{CONSENT_COPY.receiveHeading}</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
                {view.scopes.map((line) => (
                  <li key={line.scope} data-scope={line.scope}>
                    {line.text}
                  </li>
                ))}
              </ul>
              {view.extraScopes ? <p className="text-xs text-ink-500">{CONSENT_COPY.extraScopesNote}</p> : null}
            </section>

            <p className="text-sm text-ink-700">{CONSENT_COPY.assurance}</p>

            <ConsentForm
              authorizationId={view.authorizationId}
              redirectUrl={view.redirectUrl}
              workspaces={view.workspaces}
              defaultWorkspaceId={view.defaultWorkspaceId}
              currentWorkspaceName={view.currentWorkspaceName}
            />

            <p className="text-xs text-ink-500">{CONSENT_COPY.footer}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
