/**
 * The consent backend for the request being served (the consent page, its
 * actions and Connected apps). The demo reads which demo person is signed
 * in from a cookie; production never reaches the demo, because
 * getConsentBackend refuses it there (DemoModeRefusedError), which these
 * helpers answer with null so the pages show their unavailable copy.
 */

import { cookies } from "next/headers";
import { DemoModeRefusedError } from "@/lib/services/demo-mode";
import { DEMO_CONSENT_USER_COOKIE, getConsentBackend, type ConsentBackend } from "./consent-backend";

export async function consentBackendForRequest(): Promise<ConsentBackend | null> {
  try {
    const jar = await cookies();
    return getConsentBackend({ demoPerson: jar.get(DEMO_CONSENT_USER_COOKIE)?.value ?? null });
  } catch (err) {
    if (err instanceof DemoModeRefusedError) {
      return null;
    }
    throw err;
  }
}

/** Demo only: signs the demo person out of the consent page. */
export async function signOutDemoPerson(): Promise<void> {
  const jar = await cookies();
  jar.set(DEMO_CONSENT_USER_COOKIE, "signed_out", { path: "/", httpOnly: true, sameSite: "lax" });
}
