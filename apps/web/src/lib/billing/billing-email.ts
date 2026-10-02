/**
 * Billing emails to customers (docs/phases/PHASE_20.md P20-07, P0 part): the
 * plan activation email on the first paid invoice of a subscription, and
 * the same acknowledgment after a plan change made in the portal (the
 * subscription_update invoice). Each states the plan, what was charged, the
 * cadence, the renewal price from the seed, the next renewal date, what
 * canceling means, how to cancel and how to reach us, which is the
 * acknowledgment the state automatic renewal laws ask for. It carries no offer, so it stays a
 * transactional email (CAN-SPAM, 16 CFR 316.3).
 *
 * It does not wait for PHASE_18's P18-06 sender: sendBillingEmail goes
 * through the Resend fetch path the founder alerts use
 * (@curvi/trigger/spend-alerts sendResendEmail), from BILLING_EMAIL_FROM, an
 * address on the verified updates.curvi.ai domain. When P18-06 merges it
 * moves onto sendEmail as transactional with the same key.
 *
 * Once per invoice: an events row billing:email:plan_active:<invoice id>
 * (or plan_changed) is claimed (the 0003 billing dedupe index) before the send and given back if
 * the send fails, so a Stripe retry or a P20-02 reconcile replay sends it
 * then, and never twice.
 */

import type Stripe from "stripe";
import { renewalNotices } from "@curvi/pipeline/seed";
import { sendResendEmail, type ResendEmail } from "@curvi/trigger/spend-alerts";
import { eq, events, type Db } from "@curvi/db";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { formatPrice } from "./cancel-flow";
import { PRICE_CHANGE_LINE, YEARLY_CANCEL_LINE, formatRenewalDate, renewalPrice } from "./renewal-terms";
import { isPaidTierKey, tierDisplayName } from "./plans";
import type { InvoiceGrantPlan, PlanActivationSender } from "./stripe-webhook";

export const BILLING_EMAIL_FROM_ENV = "BILLING_EMAIL_FROM";

type ReadEnv = (name: string) => string | undefined;

export interface BillingEmail {
  subject: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  notice?: string;
}

/** The two plan emails: the activation on a first paid invoice, and the
 * acknowledgment of a plan change made in the portal (law and copy review
 * major 3). */
export type PlanEmailKind = "plan_active" | "plan_changed";

/** The dedupe claim for one invoice's plan email. */
export function planEmailClaimName(kind: PlanEmailKind, invoiceId: string): string {
  return `billing:email:${kind}:${invoiceId}`;
}

/** The dedupe claim for one invoice's activation email. */
export function activationClaimName(invoiceId: string): string {
  return planEmailClaimName("plan_active", invoiceId);
}

/** When the plan next renews: the latest period end among the invoice's
 * charge lines (a cadence change starts a new full period; a proration line
 * ends with the current one). */
function renewalDateOf(invoice: Stripe.Invoice): Date | null {
  let latest = 0;
  let fallback = 0;
  for (const line of invoice.lines?.data ?? []) {
    const end = line.period?.end;
    if (typeof end !== "number" || end <= 0) {
      continue;
    }
    fallback = Math.max(fallback, end);
    if ((line.amount ?? 0) >= 0) {
      latest = Math.max(latest, end);
    }
  }
  const end = latest || fallback;
  return end > 0 ? new Date(end * 1000) : null;
}

/** True when the invoice carried a discount (a promotion code, the
 * founding offer or a save offer), which may or may not apply again. */
function hadDiscount(invoice: Stripe.Invoice): boolean {
  return (invoice.total_discount_amounts ?? []).some((discount) => (discount.amount ?? 0) > 0);
}

/** A plan email for a paid subscription invoice, or null when the invoice
 * names no plan. Pure. */
export function planEmail(input: {
  kind: PlanEmailKind;
  invoice: Stripe.Invoice;
  plan: Pick<InvoiceGrantPlan, "tier" | "cadence">;
  siteUrl: string;
}): BillingEmail | null {
  const { invoice, plan } = input;
  if (!plan.tier || !plan.cadence || !isPaidTierKey(plan.tier)) {
    return null;
  }
  const name = tierDisplayName(plan.tier);
  const period = plan.cadence === "annual" ? "year" : "month";
  const renews = renewalDateOf(invoice);
  const renewsOn = renews ? formatRenewalDate(renews) : null;
  const charged = formatPrice((invoice.amount_paid ?? 0) / 100);
  const renewsAt = `${renewalPrice(plan.tier, plan.cadence)} plus any tax that applies${
    hadDiscount(invoice) ? ", less any discount that still applies" : ""
  }`;
  const [earliest, latest] = renewalNotices.annualWindow;
  const terms = [
    `Your plan renews automatically every ${period} at ${renewsAt}, until you cancel.`,
    ...(plan.cadence === "annual" ? [`We email you ${earliest} to ${latest} days before each renewal.`] : []),
    PRICE_CHANGE_LINE,
    plan.cadence === "annual" ? YEARLY_CANCEL_LINE : "If you cancel, you keep your plan until the end of the month you paid for.",
    "There is no minimum term.",
    ...(renewsOn ? [`To avoid the next charge, cancel before ${renewsOn}.`] : []),
  ].join(" ");
  const support = LEGAL_FACTS.support.email;
  const changed = input.kind === "plan_changed";
  const text = [
    changed ? `Your Curvi plan is now ${name}, billed every ${period}.` : `Your Curvi ${name} plan is active.`,
    "",
    `Plan: Curvi ${name}, billed every ${period}`,
    `Charged today: ${charged}`,
    `Renews at: ${renewsAt}`,
    ...(renewsOn ? [`Next renewal: ${renewsOn}`] : []),
    "",
    terms,
    "",
    `Cancel any time in Billing: ${input.siteUrl}/app/billing`,
    "",
    `Questions? Reply to this email or write to ${support}.`,
  ].join("\n");
  return { subject: changed ? `Your Curvi plan is now ${name}` : `Your Curvi ${name} plan is active`, text };
}

/** The activation email for a first paid subscription invoice, or null when
 * the invoice names no plan. Pure. */
export function activationEmail(input: {
  invoice: Stripe.Invoice;
  plan: Pick<InvoiceGrantPlan, "tier" | "cadence">;
  siteUrl: string;
}): BillingEmail | null {
  return planEmail({ ...input, kind: "plan_active" });
}

/** The sender is set up: a from address and a Resend key. */
export function billingEmailConfigured(readEnv: ReadEnv): boolean {
  return Boolean(readEnv(BILLING_EMAIL_FROM_ENV)) && Boolean(readEnv("RESEND_API_KEY"));
}

/**
 * Sends one billing email to a customer from BILLING_EMAIL_FROM, with
 * replies going to the support inbox. Never throws.
 */
export async function sendBillingEmail(
  email: { to: string; subject: string; text: string; idempotencyKey: string },
  opts: { readEnv: ReadEnv; send?: (email: ResendEmail) => Promise<SendResult> },
): Promise<SendResult> {
  const from = opts.readEnv(BILLING_EMAIL_FROM_ENV);
  if (!from) {
    return { ok: false, notice: `Set ${BILLING_EMAIL_FROM_ENV} to send billing emails.` };
  }
  const send = opts.send ?? ((message: ResendEmail) => sendResendEmail(message, { readEnv: opts.readEnv }));
  try {
    return await send({
      from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      replyTo: LEGAL_FACTS.support.email,
      idempotencyKey: email.idempotencyKey,
    });
  } catch (error) {
    return { ok: false, notice: String(error) };
  }
}

/** Where the once per invoice claim lives. */
export interface EmailClaims {
  /** True when this call took the claim. */
  claim(name: string, props: Record<string, unknown>): Promise<boolean>;
  /** Gives the claim back after a failed send. */
  release(name: string): Promise<void>;
}

/** Claims as events rows (the 0003 billing dedupe index). The row has no
 * workspace, so it outlives an account deletion, as the privacy page says. */
export function dbEmailClaims(db: Db): EmailClaims {
  return {
    async claim(name, props) {
      const inserted = await db
        .insert(events)
        .values({ workspaceId: null, name, props })
        .onConflictDoNothing()
        .returning({ id: events.id });
      return inserted.length > 0;
    },
    async release(name) {
      await db.delete(events).where(eq(events.name, name));
    },
  };
}

/** In memory claims, for demo mode and tests. */
export function memoryEmailClaims(): EmailClaims & { names: Set<string> } {
  const names = new Set<string>();
  return {
    names,
    async claim(name) {
      if (names.has(name)) return false;
      names.add(name);
      return true;
    },
    async release(name) {
      names.delete(name);
    },
  };
}

/** What one plan email send came to, for the billing_email_failing health
 * signal (lib/billing/signals.ts). */
export interface PlanEmailResult {
  ok: boolean;
  kind: PlanEmailKind;
  invoiceId: string;
  notice?: string;
}

export interface ActivationSenderDeps {
  claims: EmailClaims;
  readEnv: ReadEnv;
  siteUrl: string;
  send?: (email: ResendEmail) => Promise<SendResult>;
  logger?: Pick<Console, "warn" | "error">;
  /** Records each send's result; never throws (signals.ts). */
  recordResult?: (result: PlanEmailResult) => Promise<void>;
}

/** The webhook's and the reconciler's plan email sender: the activation on
 * a first paid invoice and the acknowledgment of a plan change. */
export function createActivationSender(deps: ActivationSenderDeps): PlanActivationSender {
  const logger = deps.logger ?? console;
  const record = async (result: PlanEmailResult) => {
    await deps.recordResult?.(result).catch(() => undefined);
  };

  async function sendPlanEmail(kind: PlanEmailKind, invoice: Stripe.Invoice, plan: InvoiceGrantPlan): Promise<void> {
    const invoiceId = invoice.id;
    const to = invoice.customer_email;
    const email = invoiceId ? planEmail({ kind, invoice, plan, siteUrl: deps.siteUrl }) : null;
    if (!invoiceId || !email) {
      return;
    }
    if (!to) {
      logger.warn(JSON.stringify({ msg: "billing: no customer email on the invoice, plan email not sent", kind, invoiceId }));
      return;
    }
    if (!billingEmailConfigured(deps.readEnv)) {
      // Health warns billing_email_not_configured and checkout stays closed;
      // nothing is claimed, so a replay after the setting is fixed still sends.
      logger.warn(JSON.stringify({ msg: "billing: billing email not configured, not sent", kind, invoiceId }));
      return;
    }
    const name = planEmailClaimName(kind, invoiceId);
    let claimed = false;
    try {
      claimed = await deps.claims.claim(name, { kind, invoiceId });
      if (!claimed) {
        return;
      }
      const result = await sendBillingEmail(
        { to, subject: email.subject, text: email.text, idempotencyKey: `${kind}:${invoiceId}` },
        { readEnv: deps.readEnv, send: deps.send },
      );
      if (!result.ok) {
        await deps.claims.release(name);
        logger.error(JSON.stringify({ msg: "billing: plan email failed, a replay will retry", kind, invoiceId, notice: result.notice }));
        await record({ ok: false, kind, invoiceId, notice: result.notice });
        return;
      }
      await record({ ok: true, kind, invoiceId });
    } catch (error) {
      if (claimed) {
        await deps.claims.release(name).catch(() => undefined);
      }
      logger.error(JSON.stringify({ msg: "billing: plan email failed, a replay will retry", kind, invoiceId, error: String(error) }));
      await record({ ok: false, kind, invoiceId, notice: String(error) });
    }
  }

  return {
    planActivated: (invoice, plan) => sendPlanEmail("plan_active", invoice, plan),
    planChanged: (invoice, plan) => sendPlanEmail("plan_changed", invoice, plan),
  };
}
