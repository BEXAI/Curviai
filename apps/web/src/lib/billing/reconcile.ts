/**
 * Billing reconciler (docs/phases/PHASE_20.md P20-02). A wrong endpoint, a
 * missing event type or a delivery that failed past Stripe's retries would
 * leave a payer without credits until someone noticed. Every
 * `billingReconcile.everyMinutes` the cron route lists the handled Stripe
 * events of the last `billingReconcile.lookbackHours` and replays each one
 * through the webhook's own processStripeEvent with the database store.
 *
 * Safe to replay, by construction:
 * - Grants are keyed on the paying object (invoice:<id>, checkout:<id>) and
 *   clawbacks, restores, debits and notes on their own claims, all in the
 *   events table under its unique index, with the existing locks; a replay
 *   of anything already applied writes nothing.
 * - Replays never move money in Stripe: no StripeBillingActions are
 *   passed, so a replayed customer.subscription.* event never refunds or
 *   cancels a duplicate (that stays with the live webhook). Only the read
 *   only lookup is passed, so a subscription replay writes Stripe's current
 *   state, never an old payload.
 * - A dry run (`?dryRun=1`) uses DryRunBillingStore, which reads the claims
 *   and records what it would write, and writes nothing.
 * - One bad event never stops the run: each runs in its own try and catch,
 *   and its failure is recorded with the event id, type and an error code.
 *   An event that names a workspace which no longer exists (deleted
 *   accounts cascade their events claims) is acknowledged, not failed.
 *
 * What counts as newly applied: only outcomes that moved credits on this
 * run, a grant whose ledger row was written and a debit, clawback or
 * restore that applied (CREDIT_ACTIONS below). subscription_synced,
 * payment_failure_noted, invoice_noted, checkout_noted and the other
 * acknowledgements never count.
 */

import type Stripe from "stripe";
import type { SpendAlertEmail } from "@curvi/trigger/spend-alerts";
import { siteEnvironment } from "./readiness";
import type { PriceTable } from "./price-table";
import { STRIPE_API_VERSION, STRIPE_LOOKUP_OPTIONS } from "./stripe";
import {
  disputeKey,
  HANDLED_STRIPE_EVENTS,
  processStripeEvent,
  UnroutableBillingEventError,
  type BillingLink,
  type BillingConsent,
  type BillingNote,
  type PlanActivationSender,
  type BillingStore,
  type ClawbackOutcome,
  type CreditClawback,
  type CreditDebit,
  type CreditGrant,
  type DebitOutcome,
  type DuplicateSubscriptionRecord,
  type RestoreOutcome,
  type StripeLookup,
  type StripeProcessResult,
  type SubscriptionSyncOutcome,
  type SubscriptionUpdate,
} from "./stripe-webhook";
import type { EndpointCheck, ReconcileCursor } from "./signals";

/** Stripe's limit on `types` in one events.list call (docs/verification.md). */
export const STRIPE_EVENT_TYPES_PER_LIST = 20;
/** Stripe's page size limit. */
export const STRIPE_LIST_PAGE_SIZE = 100;

/** The two Stripe resources the reconciler reads. The real client fits. */
export interface ReconcileStripeClient {
  events: {
    list(params: Stripe.EventListParams, options?: Stripe.RequestOptions): PromiseLike<Stripe.ApiList<Stripe.Event>>;
  };
  webhookEndpoints: {
    list(
      params: Stripe.WebhookEndpointListParams,
      options?: Stripe.RequestOptions,
    ): PromiseLike<Stripe.ApiList<Stripe.WebhookEndpoint>>;
  };
}

/**
 * The processStripeEvent actions that moved credits. A result with one of
 * these and no `duplicate: true` applied on this run; with `duplicate:
 * true` it had been applied before.
 */
export const CREDIT_ACTIONS: ReadonlySet<string> = new Set([
  "topup_granted",
  "cycle_credits_granted",
  "plan_change_credits_granted",
  "plan_change_credits_returned",
  "refund_clawed_back",
  "dispute_clawed_back",
  "dispute_won_credits_restored",
]);

export type ReconcileOutcome = "applied" | "already_applied" | "ignored";

/** How a processed event counts in the run. */
export function classifyOutcome(result: StripeProcessResult): ReconcileOutcome {
  if (!result.handled || !CREDIT_ACTIONS.has(result.action)) {
    return "ignored";
  }
  return result.duplicate === true ? "already_applied" : "applied";
}

export interface ReconciledEvent {
  eventId: string;
  type: string;
  action: string;
  credits: number | null;
  workspaceId: string | null;
}

export interface ReconcileFailure {
  eventId: string;
  type: string;
  /** Short code: unroutable, sync_conflict, a Stripe or Postgres error
   * code, or error. */
  code: string;
  message: string;
}

export interface ReconcileResult {
  /** Handled events listed in the window and processed. */
  scanned: number;
  applied: number;
  alreadyApplied: number;
  ignored: number;
  appliedEvents: ReconciledEvent[];
  /** Events for a workspace that no longer exists. */
  acknowledged: ReconcileFailure[];
  failed: ReconcileFailure[];
  /** Discovery or replay still has work in the frozen window. */
  truncated: boolean;
  /** Human-readable progress only; event IDs, not seconds, resume work. */
  resumeFrom: string | null;
  cursor: ReconcileCursor | null;
  /** Created time of the newest handled event in the window. */
  newestEventAt: string | null;
}

/** One discovery pass lists at most this many times maxEvents. */
export const RECONCILE_LIST_FACTOR = 10;

export interface ReconcileInput {
  stripe: ReconcileStripeClient;
  store: BillingStore;
  priceTable: PriceTable;
  /** Events created at or after this time are replayed. */
  since: Date;
  /** Freeze out the current second so newly arriving events wait for the
   * next window instead of shifting this pass's chronological boundary. */
  until?: Date;
  cursor?: ReconcileCursor | null;
  /** At most this many events a run (seed billingReconcile.maxEventsPerRun). */
  maxEvents: number;
  /** Read only lookups, so subscription replays write Stripe's current state. */
  lookup?: StripeLookup;
  /** Sends a missed activation email on a replayed first invoice (P20-07);
   * left out of a dry run. */
  activation?: PlanActivationSender;
  /** Whether a workspace row exists; an event naming a missing one is
   * acknowledged instead of failed. */
  workspaceExists?: (workspaceId: string) => Promise<boolean>;
  /** The steps the webhook route runs after processStripeEvent (PHASE_18's
   * funnel and referral steps, idempotent and keyed to the result), so a
   * replayed event gets them too; left out of a dry run. A step that
   * reports failed is listed as `after_event_failed`, and the next run in
   * the window replays the event again. */
  afterEvent?: (event: Stripe.Event, outcome: StripeProcessResult) => Promise<{ failed: boolean }>;
  logger?: Pick<Console, "warn">;
}

/**
 * Find the oldest event before applying any newer partial window. Discovery
 * persists its starting_after cursor at the cap. Once the bottom is reached,
 * ending_before walks back toward newer events, reversing each page into
 * chronological order. Event IDs preserve progress inside one created second.
 * Stripe documents both directions at https://docs.stripe.com/api/pagination.
 */
async function nextBatch(input: ReconcileInput, initial: ReconcileCursor): Promise<{
  events: Stripe.Event[]; cursor: ReconcileCursor | null; newestEventAt: string | null;
}> {
  const cursor = { ...initial };
  // One ordered stream is essential for grant/refund ordering. If the handled
  // set outgrows Stripe's filter limit, scan all types and ignore the others.
  const types = HANDLED_STRIPE_EVENTS.length <= STRIPE_EVENT_TYPES_PER_LIST ? { types: [...HANDLED_STRIPE_EVENTS] } : {};
  const params = { ...types, created: {
    gte: Math.floor(Date.parse(cursor.since) / 1000), lt: Math.floor(Date.parse(cursor.until) / 1000),
  } };
  const at = (event: Stripe.Event) => new Date(event.created * 1000).toISOString();
  const collected: Stripe.Event[] = [];
  if (cursor.phase === "seek") {
    const cap = input.maxEvents * RECONCILE_LIST_FACTOR;
    for (;;) {
      const page = await input.stripe.events.list({ ...params,
        limit: Math.min(STRIPE_LIST_PAGE_SIZE, cap - collected.length),
        ...(cursor.position ? { starting_after: cursor.position } : {}),
      }, { ...STRIPE_LOOKUP_OPTIONS });
      if (!page.data.length) {
        if (cursor.newestEventId) throw new Error("The billing discovery cursor no longer resolves inside its window.");
        return { events: [], cursor: null, newestEventAt: null };
      }
      cursor.newestEventId ??= page.data[0].id;
      cursor.newestEventAt ??= at(page.data[0]);
      collected.push(...page.data);
      const last = page.data[page.data.length - 1];
      cursor.position = last.id;
      cursor.positionAt = at(last);
      if (!page.has_more) break;
      if (collected.length >= cap) return { events: [], cursor, newestEventAt: cursor.newestEventAt };
    }
    const events = collected.reverse().slice(0, input.maxEvents);
    const last = events[events.length - 1];
    cursor.phase = "replay";
    cursor.position = last.id;
    cursor.positionAt = at(last);
    return { events, cursor: last.id === cursor.newestEventId ? null : cursor, newestEventAt: cursor.newestEventAt };
  }
  while (collected.length < input.maxEvents) {
    const page = await input.stripe.events.list({ ...params, ending_before: cursor.position!,
      limit: Math.min(STRIPE_LIST_PAGE_SIZE, input.maxEvents - collected.length),
    }, { ...STRIPE_LOOKUP_OPTIONS });
    if (!page.data.length) throw new Error("The billing replay cursor no longer resolves inside its window.");
    for (const event of [...page.data].reverse()) {
      collected.push(event);
      cursor.position = event.id;
      cursor.positionAt = at(event);
      if (event.id === cursor.newestEventId) return { events: collected, cursor: null, newestEventAt: cursor.newestEventAt };
    }
    if (!page.has_more) throw new Error("The billing replay ended before its original newest event.");
  }
  return { events: collected, cursor, newestEventAt: cursor.newestEventAt };
}

function metadataWorkspace(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null | undefined)?.workspaceId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The workspace an event names in its own data (metadata, the checkout's
 * client_reference_id or the invoice's subscription details), or null. */
export function eventWorkspaceId(event: Stripe.Event): string | null {
  const object = event.data.object as {
    metadata?: unknown;
    client_reference_id?: unknown;
    parent?: { subscription_details?: { metadata?: unknown } | null } | null;
  };
  return (
    metadataWorkspace(object.metadata) ??
    (typeof object.client_reference_id === "string" && object.client_reference_id.length > 0
      ? object.client_reference_id
      : null) ??
    metadataWorkspace(object.parent?.subscription_details?.metadata)
  );
}

function errorCode(error: unknown): string {
  if (error instanceof UnroutableBillingEventError) return "unroutable";
  if (error instanceof Error && error.name === "SubscriptionSyncConflictError") return "sync_conflict";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return "error";
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

/** Replays a bounded batch, oldest first, with durable event-ID progress. */
export async function reconcileStripe(input: ReconcileInput): Promise<ReconcileResult> {
  if (!Number.isSafeInteger(input.maxEvents) || input.maxEvents < 1) throw new Error("Use a positive reconcile event limit.");
  const initial: ReconcileCursor = input.cursor ?? {
    version: 1, phase: "seek", since: input.since.toISOString(),
    until: new Date(Math.floor((input.until ?? new Date()).getTime() / 1000) * 1000).toISOString(),
    position: null, positionAt: null, newestEventId: null, newestEventAt: null,
  };
  const batch = await nextBatch(input, initial);
  const ordered = batch.events;

  const result: ReconcileResult = {
    scanned: ordered.length,
    applied: 0,
    alreadyApplied: 0,
    ignored: 0,
    appliedEvents: [],
    acknowledged: [],
    failed: [],
    truncated: batch.cursor !== null,
    resumeFrom: batch.cursor?.positionAt ?? null,
    cursor: batch.cursor,
    newestEventAt: batch.newestEventAt,
  };
  if (result.truncated) {
    (input.logger ?? console).warn(
      JSON.stringify({ msg: "billing reconcile: more events than one run reads, the next run carries on", resumeFrom: result.resumeFrom }),
    );
  }

  for (const event of ordered) {
    if (typeof event.api_version === "string" && event.api_version.length > 0 && event.api_version !== STRIPE_API_VERSION) {
      // events.list renders an event at the account's API version when it
      // was created, not the version this build parses (security review
      // 9). Never apply a payload of another shape: fail it, which emails
      // the founder (docs/STRIPE_SETUP.md section 3: set the account's
      // default API version to the pinned one).
      result.failed.push({
        eventId: event.id,
        type: event.type,
        code: "api_version_mismatch",
        message: `The event is rendered at ${event.api_version}, not ${STRIPE_API_VERSION}.`,
      });
      continue;
    }
    try {
      const outcome = await processStripeEvent(event, input.priceTable, input.store, {
        lookup: input.lookup,
        activation: input.activation,
      });
      if (input.afterEvent && (await input.afterEvent(event, outcome)).failed) {
        result.failed.push({
          eventId: event.id,
          type: event.type,
          code: "after_event_failed",
          message: "The billing replay was applied, but a referral step failed. The next run tries it again.",
        });
      }
      switch (classifyOutcome(outcome)) {
        case "applied":
          result.applied += 1;
          result.appliedEvents.push({
            eventId: event.id,
            type: event.type,
            action: outcome.action,
            credits: typeof outcome.credits === "number" ? outcome.credits : null,
            workspaceId: eventWorkspaceId(event),
          });
          break;
        case "already_applied":
          result.alreadyApplied += 1;
          break;
        default:
          result.ignored += 1;
      }
    } catch (error) {
      const failure: ReconcileFailure = {
        eventId: event.id,
        type: event.type,
        code: errorCode(error),
        message: errorMessage(error),
      };
      const named = eventWorkspaceId(event);
      let gone = false;
      if (named && input.workspaceExists) {
        try {
          gone = !(await input.workspaceExists(named));
        } catch {
          gone = false;
        }
      }
      if (gone) {
        result.acknowledged.push({ ...failure, code: "workspace_gone" });
      } else {
        result.failed.push(failure);
        (input.logger ?? console).warn(
          JSON.stringify({ msg: "billing reconcile: event failed", eventId: event.id, type: event.type, code: failure.code }),
        );
      }
    }
  }
  // A processing failure must not move the cursor past a missing grant (or a
  // failed referral/acknowledgment). Successful writes dedupe on the retry.
  if (result.failed.length > 0) {
    result.cursor = initial;
    result.truncated = true;
    result.resumeFrom = initial.positionAt ?? initial.since;
  }
  return result;
}

/**
 * A read only BillingStore for `?dryRun=1`: every write checks its claim
 * and records what it would do instead. Reads (billingLink,
 * duplicateRetired) go to the real store. Clawback, restore and debit
 * amounts need the locked ledger read, so a dry run reports them as 0.
 */
export class DryRunBillingStore implements BillingStore {
  readonly writes: Array<{ kind: string; key: string; credits?: number }> = [];

  constructor(
    private readonly reader: Pick<BillingStore, "billingLink" | "duplicateRetired"> & {
      isClaimed(key: string): Promise<boolean>;
      consentRecorded(checkoutSessionId: string): Promise<boolean>;
    },
  ) {}

  async recordGrantOnce(key: string, grant: CreditGrant): Promise<boolean> {
    if (await this.reader.isClaimed(key)) return false;
    this.writes.push({ kind: "grant", key, credits: grant.credits });
    return true;
  }

  async upsertSubscription(update: SubscriptionUpdate): Promise<SubscriptionSyncOutcome> {
    this.writes.push({ kind: "subscription", key: update.externalId });
    return { status: "applied", subscriptionStatus: update.status };
  }

  async linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void> {
    this.writes.push({ kind: "link_customer", key: `${workspaceId}:${stripeCustomerId}` });
  }

  billingLink(workspaceId: string | null, stripeCustomerId: string | null): Promise<BillingLink | null> {
    return this.reader.billingLink(workspaceId, stripeCustomerId);
  }

  duplicateRetired(subscriptionId: string): Promise<boolean> {
    return this.reader.duplicateRetired(subscriptionId);
  }

  async recordDuplicateRetired(record: DuplicateSubscriptionRecord): Promise<void> {
    this.writes.push({ kind: "duplicate_retired", key: record.duplicateSubscriptionId });
  }

  async clawbackOnce(key: string, _clawback: CreditClawback): Promise<ClawbackOutcome> {
    if (await this.reader.isClaimed(`clawback:${key}`)) return { status: "duplicate" };
    this.writes.push({ kind: "clawback", key });
    return { status: "applied", workspaceId: "", targeted: 0, clawedBack: 0 };
  }

  async restoreDisputeOnce(disputeId: string): Promise<RestoreOutcome> {
    if (await this.reader.isClaimed(`restore:${disputeKey(disputeId)}`)) return { status: "duplicate" };
    this.writes.push({ kind: "restore", key: disputeId });
    return { status: "applied", workspaceId: "", restored: 0 };
  }

  async debitOnce(key: string, debit: CreditDebit): Promise<DebitOutcome> {
    if (await this.reader.isClaimed(key)) return { status: "duplicate" };
    this.writes.push({ kind: "debit", key, credits: debit.credits });
    return { status: "applied", debited: debit.credits, balanceAfter: 0 };
  }

  async noteOnce(eventId: string, _note: BillingNote): Promise<void> {
    if (await this.reader.isClaimed(`note:${eventId}`)) return;
    this.writes.push({ kind: "note", key: eventId });
  }

  async recordConsentOnce(consent: BillingConsent): Promise<boolean> {
    if (await this.reader.consentRecorded(consent.checkoutSessionId)) return false;
    this.writes.push({ kind: "consent", key: consent.checkoutSessionId });
    return true;
  }
}

/** The webhook URL this site registers with Stripe. */
export function webhookUrlFor(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/webhooks/stripe`;
}

function sameUrl(a: string, b: string): boolean {
  const norm = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return url.replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

function endpointProblems(
  endpoint: Stripe.WebhookEndpoint,
  apiVersion: string,
  required: readonly string[],
): string[] {
  const problems: string[] = [];
  if (endpoint.status !== "enabled") {
    problems.push("The endpoint is disabled.");
  }
  const enabled = new Set(endpoint.enabled_events);
  if (!enabled.has("*")) {
    const missing = required.filter((type) => !enabled.has(type));
    if (missing.length > 0) {
      problems.push(`It does not send ${missing.join(", ")}.`);
    }
  }
  if (endpoint.api_version !== apiVersion) {
    problems.push(
      `It renders events on ${endpoint.api_version ?? "the account default API version"}, not ${apiVersion}. The version cannot be changed, so add a new endpoint on ${apiVersion}.`,
    );
  }
  return problems;
}

/**
 * Checks that an enabled endpoint at the site's webhook URL sends every
 * handled event on the pinned API version. The signing secret cannot be
 * checked (Stripe returns it only at creation); stripe_webhook_quiet
 * covers it. Skipped on a local site, where the Stripe CLI forwards events
 * without an endpoint.
 */
export async function checkWebhookEndpoint(
  stripe: ReconcileStripeClient,
  options: {
    siteUrl: string;
    readEnv: (name: string) => string | undefined;
    apiVersion?: string;
    required?: readonly string[];
  },
): Promise<EndpointCheck> {
  if (siteEnvironment(options.readEnv) === "local") {
    return { ok: true, problems: [], skipped: "A local site gets events from the Stripe CLI, not an endpoint." };
  }
  const apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
  const required = options.required ?? HANDLED_STRIPE_EVENTS;
  const url = webhookUrlFor(options.siteUrl);
  const endpoints: Stripe.WebhookEndpoint[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.webhookEndpoints.list(
      { limit: STRIPE_LIST_PAGE_SIZE, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { ...STRIPE_LOOKUP_OPTIONS },
    );
    endpoints.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }
  const atUrl = endpoints.filter((endpoint) => sameUrl(endpoint.url, url));
  if (atUrl.length === 0) {
    return { ok: false, problems: [`No endpoint listens at ${url}.`] };
  }
  const checked = atUrl.map((endpoint) => endpointProblems(endpoint, apiVersion, required));
  if (checked.some((problems) => problems.length === 0)) {
    return { ok: true, problems: [] };
  }
  const fewest = checked.reduce((best, problems) => (problems.length < best.length ? problems : best));
  return { ok: false, problems: fewest };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The founder email after a run, or null when nothing was applied and no
 * failure is new. Grants and other credit moves are counted apart, since
 * only grants are "payments missing credits".
 */
export function composeReconcileEmail(
  result: Pick<ReconcileResult, "appliedEvents">,
  newFailures: readonly ReconcileFailure[],
): SpendAlertEmail | null {
  const grants = result.appliedEvents.filter((event) => event.action.endsWith("_granted"));
  const others = result.appliedEvents.filter((event) => !event.action.endsWith("_granted"));
  if (grants.length === 0 && others.length === 0 && newFailures.length === 0) {
    return null;
  }
  const lines: string[] = [];
  const subject: string[] = [];
  if (grants.length > 0) {
    lines.push(
      `Billing check: ${grants.length} ${plural(grants.length, "payment was", "payments were")} missing credits. ${plural(grants.length, "It is", "They are")} granted now.`,
    );
    subject.push(`${grants.length} ${plural(grants.length, "payment", "payments")} granted`);
  }
  if (others.length > 0) {
    lines.push(
      `${others.length} ${plural(others.length, "refund, dispute or plan change had", "refunds, disputes or plan changes had")} not moved credits yet. ${plural(others.length, "It is", "They are")} applied now.`,
    );
    subject.push(`${others.length} credit ${plural(others.length, "change", "changes")} applied`);
  }
  if (newFailures.length > 0) {
    lines.push(
      `${newFailures.length} billing ${plural(newFailures.length, "event", "events")} could not be applied: ${newFailures.map((failure) => failure.eventId).join(", ")}.`,
    );
    subject.push(`${newFailures.length} ${plural(newFailures.length, "event", "events")} failed`);
  }
  if (result.appliedEvents.length > 0) {
    lines.push("", "Applied:");
    for (const event of result.appliedEvents) {
      const credits = event.credits === null ? "" : `, ${event.credits} credits`;
      lines.push(`${event.eventId} (${event.type}, ${event.action}${credits}, workspace ${event.workspaceId ?? "from the customer"})`);
    }
  }
  if (newFailures.length > 0) {
    lines.push("", "Failed:");
    for (const failure of newFailures) {
      lines.push(`${failure.eventId} (${failure.type}): ${failure.code}. ${failure.message}`);
    }
    lines.push(
      "",
      "Each failed event is tried again on every run while it is in the lookback window. An unroutable event needs its customer linked to the right workspace (docs/STRIPE_SETUP.md section 3).",
    );
  }
  return { subject: `Curvi billing check: ${subject.join(", ")}`, text: lines.join("\n") };
}

/**
 * The failures to email: those not already reported. Returns the new ones
 * and the reported map to store, pruned to the lookback window.
 */
export function failuresToReport(
  failed: readonly ReconcileFailure[],
  reported: Record<string, string>,
  now: Date,
  lookbackHours: number,
): { fresh: ReconcileFailure[]; keep: Record<string, string> } {
  const cutoff = now.getTime() - lookbackHours * 60 * 60_000;
  const keep: Record<string, string> = {};
  for (const [id, at] of Object.entries(reported)) {
    if (Date.parse(at) >= cutoff) keep[id] = at;
  }
  const fresh = failed.filter((failure) => !(failure.eventId in keep));
  return { fresh, keep };
}
