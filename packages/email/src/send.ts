/**
 * One lifecycle email (docs/phases/PHASE_18.md P18-06). In order:
 *
 * 1. the address must normalize to a key (else "invalid", nothing logged);
 * 2. the dedupe key is claimed in email_sends (else "duplicate": no email is
 *    ever sent twice for one key);
 * 3. the lifecycle_email_enabled switch must be on (else "disabled");
 * 4. the address must not be suppressed for this kind (else "suppressed",
 *    final);
 * 5. the sender must be configured, and for marketing the unsubscribe link
 *    secret, the postal address and an https site too (else "disabled",
 *    with the missing variable names, never their values);
 * 6. Resend is called with the dedupe key as its Idempotency-Key, and the
 *    row ends "sent" (with Resend's id) or "failed".
 *
 * A "disabled" key and a "failed" one under the seeded attempt cap can be
 * claimed again later, so switching email on or fixing a variable loses
 * nothing the schedule still wants. Every successful send writes the funnel
 * event email_sent { template, kind } (P18-07). Never throws for a provider
 * or a database answer; the address never reaches a log or a row.
 */

import { recordFunnelEvent, type Db } from "@curvi/db";
import { emailLimits } from "@curvi/pipeline/seed";
import { bareAddress, marketingGaps, transactionalGaps, type EmailConfig } from "./config";
import { normalizedEmailKey } from "./keys";
import { unsubscribeToken } from "./links";
import { renderEmail, type EmailTemplate, type UnsubscribeLinks } from "./render";
import { postResendEmail, type FetchLike } from "./resend";
import { blocks, claimSend, finishSend, lifecycleEmailEnabled, suppressionOf } from "./store";

export type SendEmailStatus = "sent" | "failed" | "suppressed" | "disabled" | "duplicate" | "invalid";

export interface SendEmailResult {
  status: SendEmailStatus;
  /** Why it was not sent, for the cron's answer and the log (no address). */
  reason?: string;
  providerId?: string | null;
  /** A failed send worth trying again (rate limit, 5xx, no answer). */
  retryable?: boolean;
}

export interface SendEmailInput<D> {
  to: string;
  template: EmailTemplate<D>;
  data: D;
  /** At most 200 characters; one email per key, ever. */
  dedupeKey: string;
  workspaceId: string | null;
}

export interface SendEmailDeps {
  db: Pick<Db, "execute" | "insert">;
  config: EmailConfig;
  /** The lifecycle_email_enabled switch; read from platform_settings when unset. */
  enabled?: () => Promise<boolean>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  limits?: { maxAttempts: number; staleClaimMinutes: number; timeoutMs: number };
  log?: Pick<Console, "warn">;
}

/** The unsubscribe links for a recipient key: the page in the footer, the
 * one click POST target in the header, and the reply address. */
export function unsubscribeLinks(config: EmailConfig, recipientKey: string): UnsubscribeLinks | null {
  if (!config.linkSecret) {
    return null;
  }
  const token = encodeURIComponent(unsubscribeToken(config.linkSecret, recipientKey));
  return {
    pageUrl: `${config.siteUrl}/email/unsubscribe?t=${token}`,
    oneClickUrl: `${config.siteUrl}/api/email/unsubscribe?t=${token}`,
    mailto: bareAddress(config.replyTo),
  };
}

export async function sendEmail<D>(deps: SendEmailDeps, input: SendEmailInput<D>): Promise<SendEmailResult> {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? emailLimits;
  const log = deps.log ?? console;
  const { template } = input;
  const recipientKey = normalizedEmailKey(input.to);
  if (!recipientKey) {
    return { status: "invalid", reason: "not an email address" };
  }
  if (input.dedupeKey.length === 0 || input.dedupeKey.length > 200) {
    return { status: "invalid", reason: "the dedupe key must be 1 to 200 characters" };
  }

  let id: string | null;
  try {
    id = await claimSend(
      deps.db,
      { recipientKey, workspaceId: input.workspaceId, template: template.key, dedupeKey: input.dedupeKey, kind: template.kind },
      limits,
      now(),
    );
  } catch (err) {
    log.warn(`[email] could not claim a ${template.key} send:`, err instanceof Error ? err.message : String(err));
    return { status: "failed", reason: "the send log could not be written", retryable: true };
  }
  if (!id) {
    return { status: "duplicate", reason: "already sent, suppressed or in flight for this key" };
  }

  const finish = async (result: SendEmailResult, error: string | null): Promise<SendEmailResult> => {
    try {
      await finishSend(
        deps.db,
        id,
        { status: result.status as "sent" | "failed" | "suppressed" | "disabled", providerId: result.providerId, error },
        now(),
      );
    } catch (err) {
      log.warn(`[email] could not record a ${template.key} send:`, err instanceof Error ? err.message : String(err));
    }
    return result;
  };

  const enabled = await (deps.enabled ?? (() => lifecycleEmailEnabled(deps.db)))().catch(() => false);
  if (!enabled) {
    return finish({ status: "disabled", reason: "lifecycle email is switched off" }, "lifecycle email is switched off");
  }

  let scope;
  try {
    scope = await suppressionOf(deps.db, recipientKey);
  } catch {
    return finish({ status: "failed", reason: "the suppression list could not be read", retryable: true }, "suppression read failed");
  }
  if (blocks(scope, template.kind)) {
    return finish({ status: "suppressed", reason: `suppressed for ${scope} mail` }, null);
  }

  const gaps = template.kind === "marketing" ? marketingGaps(deps.config) : transactionalGaps(deps.config);
  const unsubscribe = template.kind === "marketing" ? unsubscribeLinks(deps.config, recipientKey) : undefined;
  if (gaps.length > 0 || unsubscribe === null) {
    const reason = `not configured: ${gaps.join(", ")}`;
    return finish({ status: "disabled", reason }, reason);
  }

  let rendered;
  try {
    rendered = renderEmail(template, input.data, {
      siteUrl: deps.config.siteUrl,
      founderName: deps.config.founderName,
      unsubscribe: unsubscribe ?? undefined,
      postalAddress: deps.config.postalAddress,
    });
  } catch (err) {
    const reason = `the template could not be rendered: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    return finish({ status: "failed", reason }, reason);
  }

  const sent = await postResendEmail(
    deps.config.apiKey as string,
    {
      from: deps.config.from as string,
      to: input.to.trim(),
      replyTo: deps.config.replyTo,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: rendered.headers,
    },
    { idempotencyKey: input.dedupeKey, timeoutMs: limits.timeoutMs, fetchImpl: deps.fetchImpl },
  );
  if (!sent.ok) {
    return finish({ status: "failed", reason: sent.error, retryable: sent.retryable }, sent.error);
  }
  const result = await finish({ status: "sent", providerId: sent.id }, null);
  await recordFunnelEvent(deps.db, {
    workspaceId: input.workspaceId,
    name: "email_sent",
    props: { template: template.key, kind: template.kind },
  });
  return result;
}
