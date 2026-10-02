/**
 * The /api/health warning for lifecycle email (docs/phases/PHASE_18.md
 * P18-06): lifecycle_email_not_configured while the ops:lifecycle_email_enabled
 * switch is on but a variable it needs is missing, naming the variables and
 * what does not go out. Nothing while the switch is off: email is off on
 * purpose until the founder steps are done.
 */

import { emailConfigFromEnv, lifecycleEmailEnabled, marketingGaps, transactionalGaps, type ReadEnv, type SqlDb } from "@curvi/email";

export interface EmailHealthWarning {
  code: "lifecycle_email_not_configured";
  message: string;
}

export function lifecycleEmailWarning(switchOn: boolean, readEnv: ReadEnv): EmailHealthWarning | null {
  if (!switchOn) {
    return null;
  }
  const config = emailConfigFromEnv(readEnv);
  const sender = transactionalGaps(config);
  if (sender.length > 0) {
    return {
      code: "lifecycle_email_not_configured",
      message: `Lifecycle email is switched on, but ${sender.join(", ")} ${sender.length === 1 ? "is" : "are"} not set, so no customer email goes out.`,
    };
  }
  const marketing = marketingGaps(config);
  if (marketing.length > 0) {
    return {
      code: "lifecycle_email_not_configured",
      message: `Lifecycle email is switched on, but ${marketing.join(", ")} ${marketing.length === 1 ? "is" : "are"} not set, so only transactional email goes out and every marketing email waits.`,
    };
  }
  return null;
}

/** Checks the variables, and reads the switch only when one is missing,
 * so a fully configured deploy adds no read to the health poll. */
export async function readLifecycleEmailWarning(db: SqlDb, readEnv: ReadEnv): Promise<EmailHealthWarning | null> {
  if (lifecycleEmailWarning(true, readEnv) === null) {
    return null;
  }
  return lifecycleEmailWarning(await lifecycleEmailEnabled(db), readEnv);
}
