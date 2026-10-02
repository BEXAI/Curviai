/**
 * Server side of first touch attribution (docs/phases/PHASE_18.md P18-01).
 *
 * The signup form puts an attribution hint in the signup metadata (Google
 * sign in, P18-13, sends the same object as the base64url attr parameter on
 * the callback URL). On a fresh verification the auth callback calls
 * recordSignupConfirmed, which checks the hint's shape with zod, cleans
 * every value again with the browser's rules and caps, and writes one
 * signup_attributions row per user over the owner connection (ON CONFLICT
 * DO NOTHING), then the funnel.signup_confirmed step once. Bad metadata is
 * dropped, never stored, and nothing here ever breaks the sign in.
 *
 * getSignupAttribution is the read side for the funnel email, lifecycle
 * email (P18-07), ads conversions (P18-15) and referrals (P18-24). Sellers
 * never see it.
 */

import { z } from "zod";
import { recordFunnelEvent, signupAttributions, sql, type Db, type SignupAttribution, type SignupMethod } from "@curvi/db";
import {
  cleanLandingValue,
  cleanSignupAttributionHint,
  decodeAttributionParam,
  type SignupAttributionHint,
} from "@/lib/attribution";

/** What the callback knows about the user who just verified. */
export interface SignupUser {
  id: string;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: { provider?: unknown } | Record<string, unknown> | null;
}

/** Loose shape check before cleaning: an object of short strings or null.
 * Anything else (a list, a long value, a nested object) drops the hint. */
const HintShape = z.record(z.string().max(64), z.union([z.string().max(512), z.null()])).refine(
  (value) => Object.keys(value).length <= 32,
);

/** The hint from the signup metadata, or from the attr parameter when the
 * metadata has none, cleaned. The legacy signup_source metadata (pricing
 * links before Phase 18) fills source when the hint has none. */
export function attributionFromUser(user: SignupUser, attrParam: string | null, now: Date = new Date()): SignupAttributionHint {
  const metadata = user.user_metadata ?? {};
  const raw = metadata.attribution ?? decodeAttributionParam(attrParam);
  const parsed = HintShape.safeParse(raw);
  const hint = parsed.success ? cleanSignupAttributionHint(parsed.data, now) : {};
  if (!hint.source) {
    const legacy = cleanLandingValue("source", metadata.signup_source);
    if (legacy) {
      hint.source = legacy;
    }
  }
  return hint;
}

/** Email and password, or Google (P18-13). */
export function signupMethodOf(user: SignupUser): SignupMethod {
  const provider = (user.app_metadata as { provider?: unknown } | null | undefined)?.provider;
  return provider === "google" ? "google" : "email";
}

export type SignupAttributionOutcome = "written" | "already_recorded" | "no_workspace";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/**
 * Writes the user's row in their first workspace, once. Returns what
 * happened and the workspace it went to. claim_id starts empty even when the
 * signup link carried a prospect claim: the raw token is a live bearer
 * credential for the claim and its takedown, and owners and admins can read
 * this row, so only redeeming the claim writes it, as the claim's id
 * (lib/prospects/claim.ts attributeToOutreach).
 */
export async function recordSignupAttribution(
  db: Db,
  input: { user: SignupUser; hint: SignupAttributionHint; method: SignupMethod },
): Promise<{ outcome: SignupAttributionOutcome; workspaceId: string | null }> {
  const { hint } = input;
  const userId = input.user.id;
  const inserted = rowsOf<{ workspace_id: string }>(
    await db.execute(sql`
      insert into signup_attributions (
        user_id, workspace_id, self_reported, self_reported_other, source,
        utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        ref, share_slug, claim_id, preview_id, landing_path, referrer_host,
        first_seen_at, consent, method
      )
      select
        ${userId}::uuid, m.workspace_id, ${hint.self_reported ?? null}, ${hint.self_reported_other ?? null},
        ${hint.source ?? null}, ${hint.utm_source ?? null}, ${hint.utm_medium ?? null},
        ${hint.utm_campaign ?? null}, ${hint.utm_content ?? null}, ${hint.utm_term ?? null},
        ${hint.ref ?? null}, ${hint.s ?? null}, ${null}, ${hint.preview ?? null},
        ${hint.landing_path ?? null}, ${hint.referrer_host ?? null},
        ${hint.first_seen_at ?? null}::timestamptz, ${hint.consent ?? null}, ${input.method}
      from members m
      where m.user_id = ${userId}::uuid
      order by m.created_at
      limit 1
      on conflict (user_id) do nothing
      returning workspace_id
    `),
  );
  if (inserted.length > 0) {
    return { outcome: "written", workspaceId: inserted[0].workspace_id };
  }
  const existing = await db
    .select({ workspaceId: signupAttributions.workspaceId })
    .from(signupAttributions)
    .where(sql`${signupAttributions.userId} = ${userId}::uuid`)
    .limit(1);
  return existing.length > 0
    ? { outcome: "already_recorded", workspaceId: existing[0].workspaceId }
    : { outcome: "no_workspace", workspaceId: null };
}

/**
 * The callback's one call on a fresh verification: the attribution row, then
 * funnel.signup_confirmed once per user (only when this call wrote the row,
 * or when no workspace exists yet to hold one). Never throws.
 */
export async function recordSignupConfirmed(
  db: Db,
  input: { user: SignupUser; attrParam: string | null; now?: Date },
  log: Pick<Console, "error"> = console,
): Promise<SignupAttributionOutcome | "failed"> {
  const now = input.now ?? new Date();
  const method = signupMethodOf(input.user);
  let hint: SignupAttributionHint = {};
  try {
    hint = attributionFromUser(input.user, input.attrParam, now);
    const { outcome, workspaceId } = await recordSignupAttribution(db, { user: input.user, hint, method });
    if (outcome !== "already_recorded") {
      await recordFunnelEvent(db, {
        workspaceId,
        name: "signup_confirmed",
        at: now,
        props: {
          method,
          source: hint.source ?? null,
          self_reported: hint.self_reported ?? null,
          utm_source: hint.utm_source ?? null,
          utm_campaign: hint.utm_campaign ?? null,
          consent: hint.consent ?? null,
        },
      });
    }
    return outcome;
  } catch (err) {
    // A signup must never fail because of attribution. The step is still
    // counted, without a workspace, so the weekly numbers do not lose it.
    log.error(
      JSON.stringify({
        level: "error",
        event: "signup_attribution_failed",
        user: input.user.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await recordFunnelEvent(db, {
      workspaceId: null,
      name: "signup_confirmed",
      at: now,
      props: { method, source: hint.source ?? null, self_reported: hint.self_reported ?? null },
    });
    return "failed";
  }
}

/** The attribution of a workspace's owner signup, or null. Server only. */
export async function getSignupAttribution(db: Db, workspaceId: string): Promise<SignupAttribution | null> {
  const rows = await db.query.signupAttributions.findMany({
    where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
    limit: 1,
  });
  return rows[0] ?? null;
}
