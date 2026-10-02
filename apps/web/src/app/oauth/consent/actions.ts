"use server";

import { redirect } from "next/navigation";
import { parseAuthorizationId } from "@/lib/mcp-auth/consent-backend";
import { CONSENT_COPY } from "@/lib/mcp-auth/consent-copy";
import { consentBackendForRequest, signOutDemoPerson } from "@/lib/mcp-auth/consent-request";
import { consentPath, decideConsent, type ConsentActionState, type ConsentOutcome } from "@/lib/mcp-auth/consent";

/**
 * Connect or Cancel on the consent page (PHASE_19 P19-09). The logic is
 * lib/mcp-auth/consent decideConsent: the client allowlist before any
 * redirect, the membership for the posted workspace read again, the row
 * written before the approval. A redirect leaves for the client (ChatGPT)
 * or comes back to the page when the session ended.
 */
export async function consentAction(_previous: ConsentActionState, form: FormData): Promise<ConsentActionState> {
  const backend = await consentBackendForRequest();
  if (!backend) {
    return { notice: CONSENT_COPY.unavailable, done: true };
  }
  let outcome: ConsentOutcome;
  try {
    outcome = await decideConsent(backend, {
      authorizationId: form.get("authorization_id"),
      decision: form.get("decision"),
      workspaceId: form.get("workspace_id"),
      redirectUrl: form.get("redirect_url"),
    });
  } catch (err) {
    console.error("[consent] the decision failed", err instanceof Error ? err.name : "error");
    return { notice: CONSENT_COPY.unavailable, done: true };
  }
  if (outcome.kind === "redirect") {
    redirect(outcome.url);
  }
  return { notice: outcome.text, done: outcome.done };
}

/** "Use another account": signs this browser out (only this browser, so
 * the user's other ChatGPT connections keep working) and shows the sign in
 * form for the same request, marked switched: Supabase bound the request to
 * the first account, so after signing in the page says to press Connect in
 * ChatGPT again (lib/mcp-auth/consent loadConsent). */
export async function switchAccountAction(form: FormData): Promise<void> {
  const authorizationId = parseAuthorizationId(form.get("authorization_id"));
  const backend = await consentBackendForRequest();
  if (backend?.mode === "demo") {
    await signOutDemoPerson();
  } else if (backend) {
    await backend.signOutHere();
  }
  redirect(authorizationId ? consentPath(authorizationId, { switched: true }) : "/oauth/consent");
}
