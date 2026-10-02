/**
 * Growth seed for Phase 18 (docs/phases/PHASE_18.md, principle 1 and "Seed
 * additions"). Every growth number lives here, never in the code that uses
 * it (CLAUDE.md rule 2): caps, delays, thresholds, rewards, choices and the
 * page source keys. Fal balance lines go in monitoring.ts and offers and
 * rewards that touch money in credits.ts, as the plan says.
 *
 * One section per lane, so lanes built in parallel never edit the same
 * lines. Add your values inside your own section, between its header and
 * its "End of" line, and nowhere else in this file. The seed index exports
 * this whole module (export * in ./index.ts), so a new export needs no
 * change there.
 *
 * Runtime switches: each section has a <lane>Switches list. Put the
 * platform_settings rows your lane needs there (for example
 * { key: "acquisition_paused", value: false }); growthPlatformSettingSeedRows
 * at the end joins them, and credits.ts appends that to
 * platformSettingSeedRows, which pnpm db:seed upserts. An upsert overwrites
 * the value in production on every seed, so a switch the founder flips by
 * SQL is not seeded at all: it is an operator switch under an ops: key with
 * its default in opsSwitchDefaults (operations.ts, P20-20).
 *
 * Pure data and small pure helpers only: this module is bundled into
 * client pages through @curvi/pipeline/seed.
 */

import type { PlatformSettingSeedRow } from "./credits";
import type { OpsSwitchKey } from "./operations";

// ===========================================================================
// Shared (contract commit). Lane 1 owns these after the contract; any lane
// that links to /signup with a new source adds its key here in the same
// change.
// ===========================================================================

/**
 * Where a signup link was clicked, sent as ?source= on /signup and stored on
 * signup_attributions.source (P18-01). Every key matches the
 * parseSignupSource pattern in apps/web/src/lib/safe-next.ts: lower case
 * letters, digits, underscores and hyphens, at most 40 characters.
 */
export const signupSourceKeys = [
  // The pricing page (billing/intent.ts, before Phase 18).
  "pricing",
  // P18-01 link sweep.
  "home",
  "header",
  "pillar",
  "channel",
  "category",
  "help",
  "gallery",
  "share",
  "email_capture",
  "tools",
  "compare",
  "welcome",
  // P18-04 prospect claims.
  "concierge",
  // P18-07 lifecycle email links that lead to /signup.
  "email",
  // P18-12 free preview.
  "free_preview",
  // P18-18 store image audit.
  "store_audit",
] as const;

/**
 * Source families with a variable part: tool_checker_<channel> (P18-10) and
 * lp_<variant> (P18-22). The full key still has to fit the
 * parseSignupSource pattern.
 */
export const signupSourcePrefixes = ["tool_checker_", "lp_"] as const;

export type SignupSourceKey =
  | (typeof signupSourceKeys)[number]
  | `${(typeof signupSourcePrefixes)[number]}${string}`;

/** True for a seeded source key or a key in one of the seeded families. */
export function isSignupSourceKey(value: unknown): value is SignupSourceKey {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) {
    return false;
  }
  return (
    (signupSourceKeys as readonly string[]).includes(value) ||
    signupSourcePrefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length)
  );
}

// End of Shared.

// ===========================================================================
// Lane 1 Measure (p18/measure): P18-01, P18-02, P18-15.
// ===========================================================================

/**
 * The answers to "How did you hear about Curvi?" on the signup form
 * (P18-01), stored as signup_attributions.self_reported. Keys are stable;
 * labels are the copy. "other" opens a short text field.
 */
export const signupSourceChoices = [
  { key: "search", label: "Search engine" },
  { key: "ai_assistant", label: "ChatGPT or another AI assistant" },
  { key: "youtube", label: "YouTube" },
  { key: "tiktok", label: "TikTok" },
  { key: "instagram_facebook", label: "Instagram or Facebook" },
  { key: "reddit", label: "Reddit" },
  { key: "seller_community", label: "A seller community or forum" },
  { key: "curvi_email", label: "An email from Curvi" },
  { key: "friend", label: "A friend or colleague" },
  { key: "directory", label: "A directory or launch site" },
  { key: "other", label: "Other" },
] as const satisfies readonly { key: string; label: string }[];

export type SignupSourceChoiceKey = (typeof signupSourceChoices)[number]["key"];

/** True for a seeded "How did you hear about Curvi?" answer key. */
export function isSignupSourceChoiceKey(value: unknown): value is SignupSourceChoiceKey {
  return typeof value === "string" && signupSourceChoices.some((choice) => choice.key === value);
}

/**
 * The curvi_ft first touch cookie (P18-01, founder decision 2): written
 * only after the visitor accepts cookies, never overwritten, and kept this
 * many days.
 */
export const firstTouchCookieDays = 90;

/**
 * The weekly funnel email and the operator funnel page (P18-02). The email
 * goes out once per ISO week, on the first cron call on or after sendWeekday
 * (1 is Monday) at sendHourUtc. It reports the last windowDays days and
 * everything since `since` (day 0 of docs/marketing.md). repeatWindowDays is
 * how soon a second pack counts as repeat use; topRows caps each by source
 * table; pageWeeks is how many weeks /app/ops/funnel shows.
 */
export const funnelDigest = {
  sendWeekday: 1,
  sendHourUtc: 13,
  windowDays: 7,
  since: "2026-10-01",
  repeatWindowDays: 30,
  topRows: 10,
  pageWeeks: 8,
} as const;

/** What a validation gate measures, all read from the server side funnel. */
export type ValidationGateMetric =
  /** Feedback answers "Yes, as they are" over all answers (P18-05). */
  | "usable_share"
  /** Confirmed signups with a first pack done, over confirmed signups. */
  | "activation"
  /** Workspaces with a first payment. */
  | "first_payments"
  /** Paying workspaces that paid again or started another pack within
   * repeatWindowDays of their first payment, over paying workspaces. */
  | "payer_repeat"
  /** Workspaces with a first payment over confirmed signups. */
  | "paid_share";

export interface ValidationGate {
  key: string;
  /** Day of the 90 day plan (docs/marketing.md section 5.5) and its date. */
  day: number;
  date: string;
  label: string;
  metric: ValidationGateMetric;
  unit: "percent" | "count";
  /** The doubt is not justified at or above this. */
  target: number;
  /** The doubt is justified below this; null when the plan names no line. */
  doubtBelow: number | null;
  /** The readout needs at least this many in the denominator (feedback
   * answers, confirmed signups or payers); null when any count will do. */
  minSample: number | null;
}

/**
 * The dated gates of docs/marketing.md section 5.5 (R's day 14, 30, 60 and
 * 90 decisions), compared in the weekly funnel email with the numbers since
 * funnelDigest.since. The plan's thresholds, not published rules.
 */
export const validationGates: readonly ValidationGate[] = [
  {
    key: "day14_usable",
    day: 14,
    date: "2026-10-15",
    label: "Files usable as they are",
    metric: "usable_share",
    unit: "percent",
    target: 50,
    doubtBelow: 30,
    minSample: 10,
  },
  {
    key: "day30_activation",
    day: 30,
    date: "2026-10-31",
    label: "Confirmed signups who finish a pack",
    metric: "activation",
    unit: "percent",
    target: 35,
    doubtBelow: 20,
    minSample: 20,
  },
  {
    key: "day30_first_payments",
    day: 30,
    date: "2026-10-31",
    label: "First payments",
    metric: "first_payments",
    unit: "count",
    target: 1,
    doubtBelow: null,
    minSample: null,
  },
  {
    key: "day60_payer_repeat",
    day: 60,
    date: "2026-11-30",
    label: "Payers who come back within 30 days",
    metric: "payer_repeat",
    unit: "percent",
    target: 20,
    doubtBelow: null,
    minSample: null,
  },
  {
    key: "day60_paid_share",
    day: 60,
    date: "2026-11-30",
    label: "Confirmed signups who have paid",
    metric: "paid_share",
    unit: "percent",
    target: 3,
    doubtBelow: null,
    minSample: null,
  },
  {
    key: "day90_payers",
    day: 90,
    date: "2026-12-30",
    label: "Paying workspaces",
    metric: "first_payments",
    unit: "count",
    target: 10,
    doubtBelow: null,
    minSample: null,
  },
];

export const measureSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 1 Measure.

// ===========================================================================
// Lane 2 Resilience (p18/resilience): P18-03, P18-23.
// Planned: deployRestarts. Switch: acquisition_paused.
// (falBalanceLines and the balance account list go in monitoring.ts.)
// ===========================================================================

/** The platform_settings switch the founder flips by SQL to pause
 * acquisition with no deploy (P18-03), an operator switch since P20-20. */
export const ACQUISITION_PAUSED_SETTING = "ops:acquisition_paused" satisfies OpsSwitchKey;

export interface AcquisitionGatePolicy {
  /** How long a server process reuses the gate it computed. */
  cacheSeconds: number;
  /** Browser cache of GET /api/status (cache-control max-age). Together
   * with cacheSeconds a pause reaches every page within 60 seconds. */
  statusMaxAgeSeconds: number;
}

/** P18-03: the acquisition gate's cache, in step with its 60 second promise. */
export const acquisitionGate: AcquisitionGatePolicy = { cacheSeconds: 30, statusMaxAgeSeconds: 30 };

export interface DeployRestartPolicy {
  /** Maximum pack age for recovery after a deploy (P20-33). */
  windowMinutes: number;
  /** Restarts a pack may get from deploys before it is settled as today. */
  max: number;
  /** A process looks for restarted packs at most this often (the health
   * poll, the stale-jobs cron and a new runner trigger the look). */
  pickupIntervalSeconds: number;
  /** Restarted packs one look picks up at most. */
  pickupBatch: number;
}

/** P18-23: a pack a deploy interrupted starts again once. */
export const deployRestarts: DeployRestartPolicy = { max: 1, pickupIntervalSeconds: 30, pickupBatch: 10, windowMinutes: 60 };

/** The platform_settings switch for deploy restarts (P18-23). Ships off
 * until its gate (PHASE_18 Release 5); the founder turns it on by SQL. An
 * operator switch since P20-20. */
export const DEPLOY_RESTARTS_SETTING = "ops:deploy_restarts_enabled" satisfies OpsSwitchKey;

// P20-20 (docs/phases/PHASE_20.md): PHASE_18's switches are operator
// switches under ops: keys, which pnpm db:seed never writes (the loader
// refuses an ops: row), so no later seed can reset what the founder set.
// A missing row reads as the default in opsSwitchDefaults (operations.ts),
// and migration 0038_ops_switches_and_audit copied any stored old row.
export const resilienceSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 2 Resilience.

// ===========================================================================
// Lane 3 Email (p18/email): P18-06, P18-07.
// Planned: emailLimits, lifecycleSchedule. Switch: lifecycle_email_enabled.
// ===========================================================================

/**
 * Lifecycle email volume (P18-06), kept inside Resend's free tier: 100
 * emails a day and 3,000 a month, every recipient counted, inbound mail
 * included, and 10 requests a second per team (docs/verification.md,
 * "Phase 18 email", checked 2026-10-01). The same Resend account also
 * carries the Supabase auth mail (custom SMTP, docs/LAUNCH_CHECKLIST.md
 * step 3) and the founder alerts, so lifecycle mail stops well short of
 * the daily line. 60 a day for 30 days is 1,800, under the monthly line.
 */
export interface EmailLimits {
  perRun: number;
  perUtcDay: number;
  sendSpacingMs: number;
  maxAttempts: number;
  staleClaimMinutes: number;
  timeoutMs: number;
}

export const emailLimits: EmailLimits = {
  /** Lifecycle emails one cron run sends at most; the rest wait for the next run. */
  perRun: 25,
  /** Lifecycle emails sent per UTC day at most, counted from email_sends. */
  perUtcDay: 60,
  /** Pause between two sends in one run, under Resend's 10 requests a second. */
  sendSpacingMs: 150,
  /** Tries per dedupe key after a failed send (a 429, a 5xx or no answer). */
  maxAttempts: 3,
  /** A send claimed but never finished (the process died) may be tried
   * again after this long; Resend's Idempotency-Key, kept 24 hours, stops a
   * second delivery if the first one did go out. */
  staleClaimMinutes: 15,
  /** How long one Resend call may take before it is given up. */
  timeoutMs: 10_000,
};

/** The platform_settings switch for every lifecycle email (P18-06). */
export const LIFECYCLE_EMAIL_SETTING = "ops:lifecycle_email_enabled" satisfies OpsSwitchKey;

/** The lifecycle emails (P18-07), keyed as packages/email stores them. */
export const lifecycleTemplateKeys = [
  "welcome",
  "first_pack_nudge_1",
  "first_pack_nudge_2",
  "pack_ready",
  "feedback_ask",
  "referral_rewarded",
  "out_of_credits",
  "win_back",
  "packs_back",
  "lead_results",
  "lead_tip",
  "lead_offer",
] as const;

export type LifecycleTemplateKey = (typeof lifecycleTemplateKeys)[number];

export interface LifecycleTiming {
  /** Off: never selected. The global lifecycle switch still gates every send. */
  enabled: boolean;
  /** Hours after its trigger before the email is due. */
  afterHours: number;
  /** Hours past due it may still go; later, it is dropped (so switching
   * email on never mails old signups). For held emails the hours packs
   * were paused do not count. */
  maxLateHours: number;
  /** Held while acquisition is waitlisted (P18-03), and sent once packs
   * are back if still inside maxLateHours: "held, not dropped". */
  holdWhilePaused: boolean;
}

/**
 * When each lifecycle email is due (P18-07, docs/phases/PHASE_18.md table):
 * welcome at confirmation; nudge 1 a day and nudge 2 three days after
 * confirmation with no pack started; pack ready when a pack is done;
 * feedback two days after the first pack; out of credits after a pack
 * leaves the balance below the next pack, at most once per repeatDays; win
 * back 21 days after the last pack; packs back when acquisition reopens;
 * tool results at capture; the lead tip three days and the lead offer ten
 * days after a consented capture with no signup.
 */
export interface LifecycleSchedule {
  lookbackDays: number;
  nudgePlans: readonly string[];
  outOfCreditsPlans: readonly string[];
  nudgeGapHours: number;
  outOfCreditsRepeatDays: number;
  marketingSpacingHours: number;
  leadResultSources: readonly string[];
  waitlistLeadSource: string;
  templates: Record<LifecycleTemplateKey, LifecycleTiming>;
}

export const lifecycleSchedule: LifecycleSchedule = {
  /** How far back the cron reads signups, packs, leads and sends. */
  lookbackDays: 45,
  /** Plans that get the first pack nudges (paid plans skip them). */
  nudgePlans: ["free"],
  /** Plans that get the out of credits email. */
  outOfCreditsPlans: ["free", "starter"],
  /** Nudge 2 waits at least this long after nudge 1 went out. */
  nudgeGapHours: 24,
  /** The out of credits email goes at most once in this many days. */
  outOfCreditsRepeatDays: 30,
  /** No marketing email within this many hours of any lifecycle email to
   * the same person, so a late switch on never sends two in a row. */
  marketingSpacingHours: 20,
  /** Lead sources whose capture gets the lead_results email: the tools a
   * visitor ran (packs-paused gets packs_back instead). */
  leadResultSources: ["main-image-checker", "white-background-fixer", "marketplace-resizer", "store-audit"],
  /** The lead source of the packs paused waitlist (P18-03). */
  waitlistLeadSource: "packs-paused",
  templates: {
    welcome: { enabled: true, afterHours: 0, maxLateHours: 48, holdWhilePaused: false },
    first_pack_nudge_1: { enabled: true, afterHours: 24, maxLateHours: 48, holdWhilePaused: true },
    first_pack_nudge_2: { enabled: true, afterHours: 72, maxLateHours: 72, holdWhilePaused: true },
    pack_ready: { enabled: true, afterHours: 0, maxLateHours: 24, holdWhilePaused: false },
    // P18-05's signed feedback page is now connected. The runtime switch stays off.
    feedback_ask: { enabled: true, afterHours: 48, maxLateHours: 96, holdWhilePaused: false },
    referral_rewarded: { enabled: true, afterHours: 0, maxLateHours: 72, holdWhilePaused: false },
    out_of_credits: { enabled: true, afterHours: 0, maxLateHours: 72, holdWhilePaused: true },
    win_back: { enabled: true, afterHours: 21 * 24, maxLateHours: 7 * 24, holdWhilePaused: true },
    packs_back: { enabled: true, afterHours: 0, maxLateHours: 72, holdWhilePaused: false },
    lead_results: { enabled: true, afterHours: 0, maxLateHours: 24, holdWhilePaused: false },
    lead_tip: { enabled: true, afterHours: 72, maxLateHours: 96, holdWhilePaused: true },
    lead_offer: { enabled: true, afterHours: 240, maxLateHours: 120, holdWhilePaused: true },
  },
};

// Lifecycle email ships off (P18-06). The founder turns it on by SQL after
// the sending domain, the SMTP step and the postal address (docs/PENDING.md,
// "Phase 18 founder steps, Lane 3 Email").
// P20-20 (docs/phases/PHASE_20.md): PHASE_18's switches are operator
// switches under ops: keys, which pnpm db:seed never writes (the loader
// refuses an ops: row), so no later seed can reset what the founder set.
// A missing row reads as the default in opsSwitchDefaults (operations.ts),
// and migration 0038_ops_switches_and_audit copied any stored old row.
export const emailSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 3 Email.

// ===========================================================================
// Lane 4 Proof (p18/proof): P18-08, P18-16, P18-17.
// Planned: nothing yet (the P18-17 benchmark is not built in this phase).
// ===========================================================================

export const proofSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 4 Proof.

// ===========================================================================
// Lane 5 Claims (p18/claims): P18-09.
// Planned: nothing for parts 1 and 2. Part 5 (later) adds the white or
// clear background switch.
// ===========================================================================

export const claimsSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 5 Claims.

// ===========================================================================
// Lane 6 Concierge (p18/concierge): P18-05, P18-14, P18-04.
// Planned: staffMonthlyCreditCap, the claim lifetime (30 days).
// ===========================================================================

/**
 * Pack feedback (P18-05): the card on a finished pack and the signed link
 * the day 2 email (P18-07) carries. The text caps match the pack_feedback
 * checks; linkDays is how long a signed feedback link works; digestQuotes is
 * how many new consented quotes the weekly funnel email lists.
 */
export const packFeedback = {
  commentMaxChars: 500,
  displayNameMaxChars: 60,
  linkDays: 14,
  digestQuotes: 10,
} as const;

/**
 * The share loop (P18-14). Every share button tags the page link with
 * utm_source=<network>, utm_medium and utm_campaign below, so a signup that
 * starts from a shared pack is counted by network. The sitemap lists the
 * gallery's share pages, reread at most every sitemapRefreshSeconds, at
 * most sitemapMaxShares of them.
 */
export const shareLoop = {
  utmMedium: "share",
  utmCampaign: "pack_share",
  sitemapRefreshSeconds: 3600,
  sitemapMaxShares: 60,
} as const;

/**
 * Credits an operator may add to their own workspace per calendar month
 * (UTC) for prospect packs (P18-04, "Add prospect credits"): about 50
 * typical 8 credit packs, docs/marketing.md budget line A1 for October.
 * Founder decision 18: prospect credits stay under this cap until the
 * generative still price is decided.
 */
export const staffMonthlyCreditCap = 400;

/**
 * Prospect packs and their claim links (P18-04, founder decisions 9 and
 * 11). lifetimeDays: a claim link works this long after it is made.
 * tokenBytes: random bytes in a claim token, written as hex (the signup
 * link accepts 16 to 64 lower case letters and digits). maxCreditsPerAdd:
 * the most one "Add prospect credits" adds. defaultChannels: the
 * channelChoices a new prospect pack starts with. listLimit: prospects the
 * operator page lists. kitChannelSpec: the checker rules the outreach kit
 * measures the prospect's current main image with.
 */
export const prospectClaims = {
  lifetimeDays: 30,
  tokenBytes: 20,
  maxCreditsPerAdd: 200,
  defaultChannels: ["amazon", "shopify"],
  listLimit: 100,
  kitChannelSpec: "amazon.main",
  draftNoteMaxWords: 80,
} as const;

export const conciergeSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 6 Concierge.

// ===========================================================================
// Lane 7 Search (p18/search): P18-10, P18-11, P18-18 (P18-19 not built now).
// Planned: the store audit caps. siteProfiles waits for P18-19.
// ===========================================================================

/**
 * The main image specs the free checker offers (P18-10), in picker order,
 * Amazon first. The rules themselves come from the spec registry; a spec
 * here shows in the picker only while its registry entry is verified, so
 * walmart.main and tiktokshop.main appear once P18-09 part 5 verifies them.
 */
export const mainImageCheckerSpecIds = [
  "amazon.main",
  "google.merchant.main",
  "walmart.main",
  "tiktokshop.main",
] as const;

/**
 * The store image audit (P18-18): a visitor names a Shopify store, the
 * server reads its public product list and checks each product's first
 * image against one checker channel. Deterministic, no AI calls; the cost
 * is bandwidth and CPU, so every number here bounds that.
 */
export const storeAudit = {
  /** Products read from /products.json and checked per audit. */
  maxProducts: 25,
  /** Audits one IP may run per hour. */
  auditsPerIpPerHour: 3,
  /** Audits the whole site runs per UTC day, across every visitor. */
  auditsPerDay: 100,
  /** Audits one server process runs at once; more wait for a retry. */
  concurrentAudits: 2,
  /** Image downloads in flight at once within one audit. */
  imageConcurrency: 4,
  /** Deadline for one image download, every redirect and the body included. */
  imageTimeoutMs: 10_000,
  /** Deadline and byte cap for the store's product list. */
  productListTimeoutMs: 10_000,
  productListMaxBytes: 4 * 1024 * 1024,
  /** The whole audit's deadline; products not checked by then are reported as not checked. */
  auditDeadlineMs: 45_000,
  /** A product with fewer images than this counts as thin in the summary. */
  thinImageCount: 3,
} as const;

/** platform_settings key of the store audit switch. */
export const STORE_AUDIT_SWITCH_KEY = "store_audit_enabled";

/**
 * Off until Release 4 (docs/phases/PHASE_18.md, "Release order") and the
 * reviewer pass on its server side fetches. To switch it on, set the value
 * to true here and run pnpm db:seed: the seed upserts this row, so a value
 * flipped by SQL alone is reset by the next seed.
 */
export const searchSwitches: readonly PlatformSettingSeedRow[] = [{ key: STORE_AUDIT_SWITCH_KEY, value: false }];

// End of Lane 7 Search.

// ===========================================================================
// Lane 8 Activation (p18/activation): P18-13, P18-20, P18-12.
// Planned: sellerCategories, freePreview. Switch: free_preview_enabled.
// ===========================================================================

/** One answer to "What do you sell?" on /welcome (P18-20). */
export interface SellerCategory {
  key: string;
  label: string;
}

/**
 * "What do you sell?" (P18-20), the first target segment first. Keys are
 * stored in workspaces.seller_profile and carried as ?category= on signup
 * links; the category pages (/for/<slug>) pass their slug, so a key that
 * matches a page slug (beauty, food, pet, home, apparel, jewelry,
 * electronics) preselects the answer there. Where they sell uses the
 * existing channelChoices (questions.ts).
 */
export const sellerCategories: readonly SellerCategory[] = [
  { key: "beauty", label: "Beauty and skincare" },
  { key: "supplements", label: "Supplements and health" },
  { key: "candles", label: "Candles and home fragrance" },
  { key: "food", label: "Food and drink" },
  { key: "coffee_tea", label: "Coffee and tea" },
  { key: "pet", label: "Pet products" },
  { key: "home", label: "Home goods" },
  { key: "apparel", label: "Apparel" },
  { key: "jewelry", label: "Jewelry" },
  { key: "electronics", label: "Electronics" },
  { key: "other", label: "Something else" },
];

/** True for a seeded sellerCategories key. */
export function isSellerCategoryKey(value: unknown): value is string {
  return typeof value === "string" && sellerCategories.some((category) => category.key === value);
}

/**
 * The free white main image before signup (P18-12, founder decision 6).
 * The preview (about previewLongSide pixels, the measured checks and the
 * fidelity numbers) is free with no email; the full size file needs an
 * email; the full pack needs an account. Each preview costs one seeded
 * cutout plus one small intake call, about $0.011, so the site wide count
 * and spend ceilings keep the day near $3. The feature is off unless the
 * deploy sets NEXT_PUBLIC_FREE_PREVIEW=1 with Upstash, fal and R2
 * configured, and it closes itself while packs are paused.
 */
export const freePreview = {
  /** Previews one client IP may start per UTC day (shared counter with Upstash). */
  perIpPerDay: 3,
  /** Previews the whole site may start per UTC day (spend_cap_counters). */
  sitePerDay: 300,
  /** Provider spend the previews of one UTC day may book, in USD micros. */
  siteSpendPerDayMicros: 3_300_000,
  /** Largest upload the preview takes. */
  maxBytes: 15 * 1024 * 1024,
  /** Longest side of the preview JPEG shown on the page. */
  previewLongSide: 1000,
  /** How long the preview's files and claim last (the R2 rule on anon/ matches). */
  retentionDays: 2,
  /** Lifetime of the signed full size link, in seconds. */
  fullSizeLinkSeconds: 900,
  /** Previews one web instance works on at once; each holds decoded
   * copies of a photo up to 80 megapixels, and packs share the instance. */
  maxConcurrentPerInstance: 2,
} as const;

/** Runtime kill switch for the free preview (P18-12), on by default as the
 * plan says (opsSwitchDefaults); the feature still needs
 * NEXT_PUBLIC_FREE_PREVIEW=1 and its services before it opens. The founder
 * turns it off by SQL with no deploy. */
export const FREE_PREVIEW_SETTING = "ops:free_preview_enabled" satisfies OpsSwitchKey;

// P20-20 (docs/phases/PHASE_20.md): PHASE_18's switches are operator
// switches under ops: keys, which pnpm db:seed never writes (the loader
// refuses an ops: row), so no later seed can reset what the founder set.
// A missing row reads as the default in opsSwitchDefaults (operations.ts),
// and migration 0038_ops_switches_and_audit copied any stored old row.
export const activationSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 8 Activation.

// ===========================================================================
// Lane 9 Offer (p18/offer): P18-21, P18-24 (P18-22 not built now).
// foundingMemberOffer.code, annualCode and endsOn and referralReward live in
// credits.ts. Switches: founding_offer_enabled, referrals_enabled.
// ===========================================================================

/** The platform_settings switch for the founding member banner (P18-21).
 * Off until founder decision 18 (the generative still price); the founder
 * turns it on by SQL with no deploy. */
export const FOUNDING_OFFER_SETTING = "ops:founding_offer_enabled" satisfies OpsSwitchKey;

/**
 * The founding member banner and seat counter (P18-21). The server reads
 * the switch, the acquisition gate and the promotion codes' redemptions in
 * Stripe at most once per cacheSeconds per process (failureCacheSeconds
 * after a failed Stripe read), each Stripe call bounded by stripeTimeoutMs;
 * browsers cache GET /api/offer for statusMaxAgeSeconds.
 */
export const foundingOfferBanner = {
  cacheSeconds: 300,
  failureCacheSeconds: 60,
  statusMaxAgeSeconds: 60,
  stripeTimeoutMs: 5_000,
} as const;

/**
 * The one studio price the pricing page compares a listing pack with
 * (P18-21). A third party price: checked on checkedOn at source and recorded
 * in docs/verification.md (CLAUDE.md rule 7). Recheck before changing it,
 * and drop the line rather than show a stale number.
 */
export const studioPriceComparison = {
  studio: "soona",
  usdPerPhoto: 39,
  source: "https://soona.co/pricing",
  checkedOn: "2026-10-01",
} as const;

/** The platform_settings switch for referral rewards (P18-24). Off until
 * founder decision 18; while off no invite code is issued, /r/<code> goes
 * to the home page without the code, signups record no referral and a
 * pending referral's first payment rejects it with reason rewards_off. */
export const REFERRALS_SETTING = "ops:referrals_enabled" satisfies OpsSwitchKey;

/** Invite codes (P18-24): `length` characters of lower case base32, issued
 * with at most `issueAttempts` tries on a collision. The server reads the
 * switch at most once per `switchCacheSeconds` per process. */
export const referralCodePolicy = {
  length: 8,
  issueAttempts: 5,
  switchCacheSeconds: 30,
} as const;

// Both ship off until founder decision 18.
// P20-20 (docs/phases/PHASE_20.md): PHASE_18's switches are operator
// switches under ops: keys, which pnpm db:seed never writes (the loader
// refuses an ops: row), so no later seed can reset what the founder set.
// A missing row reads as the default in opsSwitchDefaults (operations.ts),
// and migration 0038_ops_switches_and_audit copied any stored old row.
export const offerSwitches: readonly PlatformSettingSeedRow[] = [];

// End of Lane 9 Offer.

// ===========================================================================
// Joined switches. Do not edit per lane: add rows to your section's list.
// ===========================================================================

/** Every Phase 18 platform_settings row, appended to platformSettingSeedRows. */
export const growthPlatformSettingSeedRows: readonly PlatformSettingSeedRow[] = [
  ...measureSwitches,
  ...resilienceSwitches,
  ...emailSwitches,
  ...proofSwitches,
  ...claimsSwitches,
  ...conciergeSwitches,
  ...searchSwitches,
  ...activationSwitches,
  ...offerSwitches,
];

/** Offline P18-17 evidence rendering only; never part of production QC. */
export const benchmarkPolicy = {
  maxProducts: 20,
  minimumRealProducts: 10,
  maxImageBytes: 25 * 1024 * 1024,
  maxImagePixels: 24_000_000,
  maxManifestBytes: 256 * 1024,
  heatmapMaxSide: 600,
  unchangedBelowDeltaE: 1,
  backgroundBrightness: 0.2,
  colorRamp: [
    { deltaE: 1, rgb: [255, 224, 102] },
    { deltaE: 5, rgb: [244, 112, 52] },
    { deltaE: 10, rgb: [199, 45, 89] },
    { deltaE: 20, rgb: [102, 34, 110] },
  ],
} as const;
