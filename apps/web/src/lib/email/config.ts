/**
 * The web app's view of the lifecycle email configuration
 * (docs/phases/PHASE_18.md P18-06), read through lib/env at call time.
 *
 * The unsubscribe link secret is CURVI_LINK_SECRET. In demo mode only (no
 * database, so no real list and no real email) a fixed demo secret stands
 * in when it is unset, so the unsubscribe page can be tried locally and in
 * the e2e suite; in db mode an unset secret means no link verifies.
 */

import { emailConfigFromEnv, type EmailConfig } from "@curvi/email";
import { optionalEnv } from "@/lib/env";
import { isDbMode } from "@/lib/services";

/** Demo mode only; never used with a database. */
export const DEMO_LINK_SECRET = "curvi-demo-link-secret";

export function lifecycleEmailConfig(): EmailConfig {
  return emailConfigFromEnv(optionalEnv);
}

/** The secret signed links verify against, or null when none is set in db mode. */
export function linkSecret(): string | null {
  const secret = optionalEnv("CURVI_LINK_SECRET")?.trim();
  if (secret) return secret;
  return isDbMode() ? null : DEMO_LINK_SECRET;
}
