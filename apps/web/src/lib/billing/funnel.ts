/**
 * Stripe's part of the server side funnel (docs/phases/PHASE_18.md P18-02):
 * checkout_completed for every completed Checkout Session, and payment
 * (with the workspace's first_payment once) for money that granted credits.
 *
 * The webhook route calls recordStripeFunnel after processStripeEvent, so
 * the billing logic stays as it is:
 * - A payment is recorded only when this delivery applied the grant
 *   (result.duplicate is not true), so a Stripe retry never counts twice,
 *   and only when money moved (amount above zero; a 100 percent promotion
 *   code grants credits but is not a payment). Its workspace is the one the
 *   grant was booked to: the billing:stripe:<key> claim row the billing
 *   store wrote resolves metadata and the customer link the same way.
 * - checkout_completed has no grant to lean on in subscription mode, so a
 *   step for a session already recorded is skipped.
 *
 * Amounts follow Stripe (minor units, docs.stripe.com/api, checked
 * 2026-10-01): amount_usd is set for usd only. promotion_code is the
 * promotion code object's id, never the code text. Never throws.
 */

import type Stripe from "stripe";
import { recordFunnelEvent, sql, type Db, type FunnelProps } from "@curvi/db";
import type { PriceTable } from "./price-table";
import { planInvoiceGrant, type StripeProcessResult } from "./stripe-webhook";

export interface StripeFunnelStep {
  name: "checkout_completed" | "payment";
  /** The workspace from the event metadata, used when no grant row names one. */
  workspaceHint: string | null;
  /** The billing store key of the grant this payment applied, e.g.
   * invoice:in_123, whose claim row names the workspace. */
  grantKey: string | null;
  props: FunnelProps;
}

const GRANTED_ACTIONS = new Set(["topup_granted", "cycle_credits_granted", "plan_change_credits_granted"]);

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return typeof value.id === "string" ? value.id : null;
}

/** Minor units to dollars for usd; null for any other currency. */
function usd(amount: number | null | undefined, currency: string | null | undefined): number | null {
  return typeof amount === "number" && Number.isFinite(amount) && (currency ?? "").toLowerCase() === "usd"
    ? Math.round(amount) / 100
    : null;
}

function sessionWorkspace(session: Stripe.Checkout.Session): string | null {
  return metadataValue(session.metadata, "workspaceId") ?? session.client_reference_id ?? null;
}

function sessionPromotionCode(session: Stripe.Checkout.Session): string | null {
  for (const discount of session.discounts ?? []) {
    const id = idOf(discount.promotion_code as string | { id?: string } | null);
    if (id) {
      return id;
    }
  }
  return null;
}

function sessionProps(session: Stripe.Checkout.Session): Record<string, string | number | boolean | null> {
  return {
    checkout_session: session.id,
    kind: metadataValue(session.metadata, "kind"),
    plan: metadataValue(session.metadata, "plan"),
    cadence: metadataValue(session.metadata, "cadence"),
    checkout_source: metadataValue(session.metadata, "source"),
    amount_usd: usd(session.amount_total, session.currency),
    currency: session.currency ?? null,
    discounted: (session.total_details?.amount_discount ?? 0) > 0,
    promotion_code: sessionPromotionCode(session),
  };
}

/** The funnel steps one processed Stripe event stands for. Pure. */
export function stripeFunnelSteps(
  event: Stripe.Event,
  result: StripeProcessResult,
  table: PriceTable,
): StripeFunnelStep[] {
  const granted = GRANTED_ACTIONS.has(result.action) && result.duplicate !== true;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      const steps: StripeFunnelStep[] = [];
      if (event.type === "checkout.session.completed") {
        steps.push({
          name: "checkout_completed",
          workspaceHint: sessionWorkspace(session),
          grantKey: null,
          props: sessionProps(session),
        });
      }
      if (granted && result.action === "topup_granted" && (session.amount_total ?? 0) > 0) {
        steps.push({
          name: "payment",
          workspaceHint: sessionWorkspace(session),
          grantKey: `checkout:${session.id}`,
          props: { ...sessionProps(session), kind: "topup", plan: "topup", credits: result.credits ?? null },
        });
      }
      return steps;
    }
    case "invoice.paid": {
      const invoice = event.data.object;
      if (!granted || !invoice.id || !((invoice.amount_paid ?? 0) > 0)) {
        return [];
      }
      const plan = planInvoiceGrant(invoice, table);
      const subscriptionDetails =
        invoice.parent?.type === "subscription_details" ? invoice.parent.subscription_details : null;
      return [
        {
          name: "payment",
          workspaceHint:
            metadataValue(subscriptionDetails?.metadata ?? null, "workspaceId") ??
            metadataValue(invoice.metadata ?? null, "workspaceId"),
          grantKey: `invoice:${invoice.id}`,
          props: {
            kind: "subscription",
            plan: plan.tier,
            cadence: plan.cadence,
            billing_reason: plan.billingReason,
            amount_usd: usd(invoice.amount_paid, invoice.currency),
            currency: invoice.currency ?? null,
            credits: result.credits ?? null,
          },
        },
      ];
    }
    default:
      return [];
  }
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** Writes the steps of one processed event. Never throws. */
export async function recordStripeFunnel(
  db: Db,
  event: Stripe.Event,
  result: StripeProcessResult,
  table: PriceTable,
  log: Pick<Console, "error"> = console,
): Promise<number> {
  let written = 0;
  try {
    for (const step of stripeFunnelSteps(event, result, table)) {
      let workspaceId = step.workspaceHint;
      if (step.grantKey) {
        const booked = rowsOf<{ workspace_id: string | null }>(
          await db.execute(
            sql`select workspace_id from events where name = ${`billing:stripe:${step.grantKey}`} limit 1`,
          ),
        );
        workspaceId = booked[0]?.workspace_id ?? workspaceId;
      }
      if (step.name === "checkout_completed") {
        const seen = rowsOf(
          await db.execute(sql`
            select 1 from events
            where name = 'funnel.checkout_completed' and props ->> 'checkout_session' = ${String(step.props.checkout_session)}
            limit 1
          `),
        );
        if (seen.length > 0) {
          continue;
        }
        const recorded = await recordFunnelEvent(db, { workspaceId, name: "checkout_completed", props: step.props });
        written += recorded.recorded ? 1 : 0;
        continue;
      }
      const recorded = await recordFunnelEvent(db, { workspaceId, name: "payment", first: true, props: step.props });
      written += recorded.recorded ? 1 : 0;
    }
  } catch (err) {
    log.error(
      JSON.stringify({
        level: "error",
        event: "stripe_funnel_failed",
        eventId: event.id,
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return written;
}
