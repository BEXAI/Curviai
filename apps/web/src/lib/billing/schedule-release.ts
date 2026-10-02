/**
 * A subscription schedule attached to a subscription: a downgrade (or a
 * move to monthly billing) the founder scheduled by hand in the Stripe
 * Dashboard for the next renewal (docs/phases/PHASE_20.md P20-06 stopgap).
 * While one is attached the portal can neither update nor cancel the
 * subscription, so the upgrade portal and the cancel flow release it first.
 *
 * A release undoes what the subscriber asked us for by email, so it is
 * never silent (security review 2, law and copy review major 7):
 * - the subscriber is told before it happens: the upgrade asks them to
 *   confirm ("This cancels your move to Starter on November 3, 2026."), and
 *   the cancel flow says it at the top before any choice;
 * - every release is recorded (an events row
 *   billing:schedule_released:<schedule id>) and emailed to the founder;
 * - a later Stripe failure says the move was already canceled.
 */

import type Stripe from "stripe";
import { events, type Db } from "@curvi/db";
import { sendFounderEmail } from "@curvi/trigger/spend-alerts";
import { tierDisplayName, type BillingCadence, type PaidTierKey } from "./plans";
import type { PriceTable } from "./price-table";
import { formatRenewalDate } from "./renewal-terms";
import { clearPendingChange } from "./scheduled-change";

const STRIPE_OPTIONS = { timeout: 15_000, maxNetworkRetries: 1 } as const satisfies Stripe.RequestOptions;

/** What an attached schedule would change, as far as it can be read. */
export interface ScheduledChange {
  scheduleId: string;
  /** The plan and cadence of the next phase; null when unknown. */
  tier: PaidTierKey | null;
  cadence: BillingCadence | null;
  /** When the next phase starts; null when unknown. */
  startsAt: Date | null;
}

/** Where a release happened. */
export type ReleasePath = "upgrade" | "pause" | "discount" | "cancel";

export interface ScheduleReleaseEvent {
  workspaceId: string;
  subscriptionId: string;
  change: ScheduledChange;
  path: ReleasePath;
}

/** Records and reports a release. Never throws. */
export type OnScheduleReleased = (event: ScheduleReleaseEvent) => Promise<void>;

/**
 * Reads the schedule's next phase. A failed read still returns the id, so
 * the notice falls back to "your move at your next renewal".
 */
export async function describeScheduledChange(
  stripe: Stripe,
  scheduleId: string,
  table: PriceTable,
  now: Date = new Date(),
): Promise<ScheduledChange> {
  try {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, STRIPE_OPTIONS);
    const nowSeconds = now.getTime() / 1000;
    const next = (schedule.phases ?? []).find((phase) => phase.start_date > nowSeconds);
    const price = next?.items?.[0]?.price;
    const priceId = typeof price === "string" ? price : (price?.id ?? null);
    const mapping = priceId ? table[priceId] : undefined;
    return {
      scheduleId,
      tier: mapping?.kind === "tier" ? (mapping.tier as PaidTierKey) : null,
      cadence: mapping?.kind === "tier" ? mapping.cadence : null,
      startsAt: next ? new Date(next.start_date * 1000) : null,
    };
  } catch (error) {
    console.warn(JSON.stringify({ msg: "billing: could not read a subscription schedule", scheduleId, error: String(error) }));
    return { scheduleId, tier: null, cadence: null, startsAt: null };
  }
}

/** "your move to Starter on November 3, 2026", or "your move to monthly
 * billing on ..." for a cadence change on the same plan. */
export function scheduledChangeText(change: ScheduledChange, currentTier?: string | null): string {
  const what = !change.tier
    ? "a smaller plan"
    : change.tier === currentTier && change.cadence
      ? `${change.cadence === "annual" ? "yearly" : "monthly"} billing`
      : tierDisplayName(change.tier);
  return change.startsAt
    ? `your move to ${what} on ${formatRenewalDate(change.startsAt)}`
    : `your move to ${what} at your next renewal`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Asked before an upgrade releases the schedule. */
export function upgradeReleaseNotice(change: ScheduledChange, currentTier?: string | null): string {
  return `This cancels ${scheduledChangeText(change, currentTier)}. Choose Continue to upgrade anyway.`;
}

/** Shown at the top of the cancel flow while a schedule is attached. */
export function cancelFlowReleaseNotice(change: ScheduledChange, currentTier?: string | null): string {
  return `${capitalized(scheduledChangeText(change, currentTier))} is set up. Pausing billing, taking an offer or canceling here cancels that move.`;
}

/** When Stripe refused the change after the schedule was released. */
export function releasedThenFailedNotice(change: ScheduledChange, currentTier?: string | null): string {
  return `Stripe could not make that change just now. ${capitalized(scheduledChangeText(change, currentTier))} was already canceled, so email hello@curvi.ai if you still want it. Try again in a minute.`;
}

/** The founder's email about one release. */
export function releaseEmail(event: ScheduleReleaseEvent): { subject: string; text: string } {
  const { change } = event;
  const target = change.tier
    ? `${tierDisplayName(change.tier)}${change.cadence ? `, billed ${change.cadence === "annual" ? "yearly" : "monthly"}` : ""}`
    : "an unknown price";
  return {
    subject: "Curvi billing: a scheduled plan change was canceled",
    text: [
      `A plan change you scheduled in Stripe was released when the subscriber chose to ${event.path === "upgrade" ? "upgrade" : event.path === "cancel" ? "cancel" : event.path === "pause" ? "pause billing" : "take the discount offer"}.`,
      "",
      `Workspace: ${event.workspaceId}`,
      `Subscription: ${event.subscriptionId}`,
      `Schedule: ${change.scheduleId}`,
      `It would have moved to: ${target}${change.startsAt ? ` on ${formatRenewalDate(change.startsAt)}` : ""}`,
      "",
      "The subscriber was told before the release. If they still want the change, schedule it again in the Stripe Dashboard for the period end.",
    ].join("\n"),
  };
}

/** The events row name for one release (the 0003 billing dedupe index). */
export function releaseEventName(scheduleId: string): string {
  return `billing:schedule_released:${scheduleId}`;
}

/** The live notifier: an events row and the founder email. Never throws. */
export function liveScheduleReleaseNotifier(deps: {
  db: Db | null;
  readEnv?: (name: string) => string | undefined;
  sendEmail?: typeof sendFounderEmail;
}): OnScheduleReleased {
  const send = deps.sendEmail ?? sendFounderEmail;
  return async (event) => {
    if (deps.db) {
      try {
        await clearPendingChange(deps.db, event.change.scheduleId, event.workspaceId);
        await deps.db
          .insert(events)
          .values({
            workspaceId: event.workspaceId,
            name: releaseEventName(event.change.scheduleId),
            props: {
              path: event.path,
              subscriptionId: event.subscriptionId,
              scheduleId: event.change.scheduleId,
              tier: event.change.tier,
              cadence: event.change.cadence,
              startsAt: event.change.startsAt?.toISOString() ?? null,
            },
          })
          .onConflictDoNothing();
      } catch (error) {
        console.error(JSON.stringify({ msg: "billing: schedule release not recorded", scheduleId: event.change.scheduleId, error: String(error) }));
      }
    }
    try {
      const result = await send(releaseEmail(event), deps.readEnv ? { readEnv: deps.readEnv } : {});
      if (!result.ok) {
        console.error(JSON.stringify({ msg: "billing: schedule release email not sent", scheduleId: event.change.scheduleId, notice: result.notice }));
      }
    } catch (error) {
      console.error(JSON.stringify({ msg: "billing: schedule release email failed", scheduleId: event.change.scheduleId, error: String(error) }));
    }
  };
}
