/**
 * Server side funnel events (docs/phases/PHASE_18.md P18-02). No new table
 * and no new vendor: each step is a row in the existing events table named
 * funnel.<name>, and the weekly funnel email, the operator funnel page and
 * the saved SQL read them back. Client PostHog events stay as they are; these
 * cover what the server sees whatever the visitor's cookie choice.
 *
 * With first: true a step is also written once per workspace as
 * funnel.first_<name> (first pack started, first pack done, first download,
 * first payment). The partial unique index events_funnel_first_uq on
 * (workspace_id, name) where name like 'funnel.first_%' (migration
 * attribution_and_funnel, Lane 1) makes that once only under concurrency;
 * the insert also checks for an existing row, so it holds in sequence on a
 * database without that index.
 *
 * recordFunnelEvent never throws: a funnel row must never break the action
 * it records. Props are small flat values (strings, numbers, booleans),
 * never emails, file keys or free text a person typed.
 */

import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { events } from "./schema";

export const FUNNEL_EVENT_PREFIX = "funnel.";
export const FIRST_FUNNEL_EVENT_PREFIX = "funnel.first_";

/**
 * Every funnel step and the item that writes it. Lanes write only the names
 * listed here; a lane that needs a new step adds it to this list in the
 * same change.
 *
 * The weekly funnel email and /app/ops/funnel (apps/web/src/lib/
 * funnel-report.ts) count every step by name, and read these props:
 * signup_confirmed { method, source, self_reported, utm_source,
 * utm_campaign }, pack_done { job_id } (repeat use counts distinct jobs),
 * payment { amount_usd }, and feedback_submitted { usable: "yes" | "some" |
 * "not_yet" } (the usable share counts "yes"). prospect_pack_made and the
 * claim steps are counted from the operator's workspace as well; every
 * other step leaves workspaces owned by an OPS_EMAILS account out.
 */
export const FUNNEL_EVENT_NAMES = [
  // P18-02 (Lane 1 Measure).
  "signup_confirmed",
  "pack_started",
  "pack_done",
  "download",
  "checkout_completed",
  "payment",
  "share_published",
  "lead_captured",
  // P18-03 and P18-23 (Lane 2 Resilience). Workspace null for the gate.
  "acquisition_paused",
  "acquisition_resumed",
  "pack_restarted",
  // P18-06 and P18-07 (Lane 3 Email). Props: template.
  "email_sent",
  // P18-05 and P18-04 (Lane 6 Concierge).
  "feedback_submitted",
  "prospect_pack_made",
  "claim_redeemed",
  "claim_taken_down",
  // P18-18 (Lane 7 Search).
  "store_audit_run",
  // P18-20 and P18-12 (Lane 8 Activation).
  "segment_answered",
  "preview_made",
  "preview_claimed",
  // P18-24 (Lane 9 Offer).
  "referral_link_created",
  "referral_signup",
  "referral_qualified",
  "referral_rewarded",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

/** The steps that also have a once per workspace "first" event. */
export const FIRST_FUNNEL_EVENT_NAMES = ["pack_started", "pack_done", "download", "payment"] as const;

export type FirstFunnelEventName = (typeof FIRST_FUNNEL_EVENT_NAMES)[number];

/** Flat props only. Anything else is dropped before the row is written. */
export type FunnelProps = Readonly<Record<string, string | number | boolean | null>>;

interface FunnelEventBase {
  /** Null for steps with no workspace yet (a lead, the acquisition gate). */
  workspaceId: string | null;
  props?: FunnelProps;
  /** When the step happened; now when unset. For tests and backfills. */
  at?: Date;
}

export type FunnelEventInput =
  | (FunnelEventBase & { name: FirstFunnelEventName; first?: boolean })
  | (FunnelEventBase & { name: Exclude<FunnelEventName, FirstFunnelEventName>; first?: false });

export interface FunnelRecordResult {
  /** The funnel.<name> row was written. */
  recorded: boolean;
  /** This call wrote the workspace's funnel.first_<name> row (false when it already existed). */
  firstRecorded: boolean;
}

/** The two calls recordFunnelEvent makes on the database. */
export type FunnelEventWriter = Pick<Db, "insert" | "execute">;

export interface RecordFunnelEventOptions {
  log?: Pick<Console, "error">;
}

const MAX_PROPS = 20;
const MAX_PROP_KEY_LENGTH = 40;
const MAX_PROP_STRING_LENGTH = 200;
const PROP_KEY = /^[a-z][a-z0-9_]*$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export function isFunnelEventName(value: unknown): value is FunnelEventName {
  return typeof value === "string" && (FUNNEL_EVENT_NAMES as readonly string[]).includes(value);
}

export function isFirstFunnelEventName(value: unknown): value is FirstFunnelEventName {
  return typeof value === "string" && (FIRST_FUNNEL_EVENT_NAMES as readonly string[]).includes(value);
}

/** The events.name of a step: funnel.<name>. */
export function funnelEventName(name: FunnelEventName): string {
  return `${FUNNEL_EVENT_PREFIX}${name}`;
}

/** The events.name of a step's once per workspace row: funnel.first_<name>. */
export function firstFunnelEventName(name: FirstFunnelEventName): string {
  return `${FIRST_FUNNEL_EVENT_PREFIX}${name}`;
}

/**
 * Keeps at most MAX_PROPS snake_case keys with string, finite number,
 * boolean or null values; cuts long strings and drops anything that looks
 * like an email address.
 */
export function cleanFunnelProps(props: unknown): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return clean;
  }
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (Object.keys(clean).length >= MAX_PROPS) {
      break;
    }
    if (key.length > MAX_PROP_KEY_LENGTH || !PROP_KEY.test(key)) {
      continue;
    }
    if (value === null || typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) {
        clean[key] = value;
      }
    } else if (typeof value === "string") {
      if (!EMAIL_LIKE.test(value)) {
        clean[key] = value.slice(0, MAX_PROP_STRING_LENGTH);
      }
    }
  }
  return clean;
}

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) {
    return result.length;
  }
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

function logFailure(log: Pick<Console, "error">, name: string, err: unknown): void {
  log.error(
    JSON.stringify({
      level: "error",
      event: "funnel_event_failed",
      name,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Writes funnel.<name>, and with first: true (and a workspace) also
 * funnel.first_<name> unless the workspace already has one. Never throws;
 * a failed write is logged without its props and reported as not recorded.
 */
export async function recordFunnelEvent(
  db: FunnelEventWriter,
  input: FunnelEventInput,
  options: RecordFunnelEventOptions = {},
): Promise<FunnelRecordResult> {
  const log = options.log ?? console;
  const result: FunnelRecordResult = { recorded: false, firstRecorded: false };
  if (!isFunnelEventName(input.name)) {
    logFailure(log, String(input.name), new Error("unknown funnel event name"));
    return result;
  }
  const props = cleanFunnelProps(input.props);
  const at = input.at ?? new Date();
  try {
    await db.insert(events).values({
      workspaceId: input.workspaceId,
      name: funnelEventName(input.name),
      props,
      at,
    });
    result.recorded = true;
  } catch (err) {
    logFailure(log, input.name, err);
  }
  if (input.first && input.workspaceId && isFirstFunnelEventName(input.name)) {
    const name = firstFunnelEventName(input.name);
    try {
      const inserted = await db.execute(sql`
        insert into events (workspace_id, name, props, at)
        select ${input.workspaceId}::uuid, ${name}, ${JSON.stringify(props)}::jsonb, ${at.toISOString()}::timestamptz
        where not exists (
          select 1 from events where workspace_id = ${input.workspaceId}::uuid and name = ${name}
        )
        on conflict do nothing
        returning id
      `);
      result.firstRecorded = rowCount(inserted) > 0;
    } catch (err) {
      logFailure(log, name, err);
    }
  }
  return result;
}
