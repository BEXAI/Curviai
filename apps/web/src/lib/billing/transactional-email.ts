import { emailConfigFromEnv, sendEmail, type EmailTemplate } from "@curvi/email";
import type { Db } from "@curvi/db";
import type { ResendEmail } from "@curvi/trigger/spend-alerts";
import { LEGAL_FACTS } from "@/lib/legal/facts";

const template: EmailTemplate<{ subject: string; text: string }> = {
  key: "billing_notice", kind: "transactional", audience: "account",
  render: (data) => ({ subject: data.subject, paragraphs: data.text.split(/\n\n+/) }),
};

/** Billing remains available when optional lifecycle campaigns are switched off. */
export function billingTransactionalSender(db: Db, readEnv: (name: string) => string | undefined) {
  const config = { ...emailConfigFromEnv(readEnv), from: readEnv("BILLING_EMAIL_FROM") ?? null, replyTo: LEGAL_FACTS.support.email };
  return async (email: ResendEmail): Promise<{ ok: boolean; notice?: string }> => {
    if (!email.idempotencyKey) return { ok: false, notice: "Billing email requires an idempotency key." };
    const result = await sendEmail({ db, config, enabled: async () => true }, {
      to: email.to, template, data: { subject: email.subject, text: email.text },
      dedupeKey: email.idempotencyKey, workspaceId: null,
    });
    return { ok: ["sent", "duplicate", "suppressed"].includes(result.status), notice: result.reason };
  };
}
