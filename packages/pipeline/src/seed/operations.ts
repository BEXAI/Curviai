/**
 * Operations seed (docs/phases/PHASE_20.md, "Seed summary"). The numbers the
 * operations code reads live here, never in that code (CLAUDE.md rule 2).
 *
 * Operator switches: values the founder sets at runtime live in
 * platform_settings under an `ops:` key. The seed never writes an `ops:` row,
 * because pnpm db:seed upserts every seeded row and would reset the founder's
 * choice on every release. A key with no stored row reads as its entry in
 * opsSwitchDefaults, through opsSwitch in apps/web/src/lib/features.ts (the
 * 30 second cached reader). P20-20 moves today's switches onto these keys
 * (expand, then contract); the contract commit only defines them.
 *
 * One section per lane below, so lanes never edit the same lines.
 *
 * Pure data and small pure helpers only: this module is bundled into client
 * pages through @curvi/pipeline/seed.
 */

// ===========================================================================
// Operator switches (contract; Lane 5 Operator basics, P20-20, owns changes).
// ===========================================================================

/** The prefix of every operator switch key in platform_settings. */
export const OPS_SWITCH_PREFIX = "ops:";

/**
 * A switch that is on or off, with who set it and why. ops:packs_paused
 * (P20-19) shows `message` to sellers while on; ops:deploy_pending (P20-19)
 * reads as off once `expiresAt` has passed, so a release script that dies
 * never holds packs for long.
 */
export interface OpsFlag {
  on: boolean;
  message?: string;
  setBy?: string;
  /** ISO time the operator set it. */
  setAt?: string;
  /** ISO time after which readers treat the flag as off. */
  expiresAt?: string;
}

/** The value types an operator switch can hold. `usd` is a dollar amount,
 * or null for "not set" (the next source in the reader's precedence). */
export interface OpsSwitchValueByKind {
  boolean: boolean;
  flag: OpsFlag;
  usd: number | null;
}

export type OpsSwitchKind = keyof OpsSwitchValueByKind;

/**
 * One switch's fallbacks. `default` applies when no row is stored;
 * `onReadError` when the row cannot be read or holds a value of the wrong
 * shape. Kill switches fail closed (as outputOptionsSwitchOn does today);
 * pauses fail open, since monitoring and pausing never break a request.
 */
export type OpsSwitchDefault = {
  [K in OpsSwitchKind]: { kind: K; default: OpsSwitchValueByKind[K]; onReadError: OpsSwitchValueByKind[K] };
}[OpsSwitchKind];

const FLAG_OFF: OpsFlag = { on: false };

/**
 * Every operator switch and its fallbacks (P20-20). PHASE_18's keys are
 * defined here even before PHASE_18 merges; its features read them through
 * opsSwitch when they land.
 */
export const opsSwitchDefaults = {
  // Seller output options (PHASE_15), today `output_options_enabled`, seeded
  // true. A failed read keeps options off, as today.
  "ops:output_options_enabled": { kind: "boolean", default: true, onReadError: false },
  // P18-03 acquisition pause, `acquisition_paused` on PHASE_18. Only the
  // founder pauses; a failed read leaves acquisition open, as P18-03 does.
  "ops:acquisition_paused": { kind: "boolean", default: false, onReadError: false },
  // P18-12 free preview kill switch, `free_preview_enabled` (seeded true on
  // PHASE_18; the feature also needs NEXT_PUBLIC_FREE_PREVIEW=1).
  "ops:free_preview_enabled": { kind: "boolean", default: true, onReadError: false },
  // P18-06 lifecycle email, `lifecycle_email_enabled`, ships off.
  "ops:lifecycle_email_enabled": { kind: "boolean", default: false, onReadError: false },
  // P18-24 referral rewards, `referrals_enabled`, ships off.
  "ops:referrals_enabled": { kind: "boolean", default: false, onReadError: false },
  // P18-09 part 5, the white or clear background check, off until it ships.
  "ops:background_white_or_clear": { kind: "boolean", default: false, onReadError: false },
  // P20-19: createJob refuses new packs while on. Fails open.
  "ops:packs_paused": { kind: "flag", default: FLAG_OFF, onReadError: FLAG_OFF },
  // P20-19: new packs queue instead of starting during a release. Fails open
  // and expires by its own expiresAt.
  "ops:deploy_pending": { kind: "flag", default: FLAG_OFF, onReadError: FLAG_OFF },
  // P20-37: the daily global hard stop in dollars. Null means not set, so the
  // env (DAILY_SPEND_HARD_STOP_USD) and then the seed apply.
  "ops:global_hard_stop_usd": { kind: "usd", default: null, onReadError: null },
  // P18-23 restarts of packs a deploy interrupted, `deploy_restarts_enabled`
  // on PHASE_18 (seeded off with keepStored). Lane 5 moved it here because
  // the founder turns it on by SQL. Off until its gate; a failed read keeps
  // restarts off.
  "ops:deploy_restarts_enabled": { kind: "boolean", default: false, onReadError: false },
  // P18-21 founding member banner, `founding_offer_enabled` on PHASE_18
  // (seeded off with keepStored), for the same reason. A failed read hides
  // the banner.
  "ops:founding_offer_enabled": { kind: "boolean", default: false, onReadError: false },
} as const satisfies Record<`${typeof OPS_SWITCH_PREFIX}${string}`, OpsSwitchDefault>;

export type OpsSwitchKey = keyof typeof opsSwitchDefaults;

/**
 * The platform_settings key each switch had before P20-20 (main's
 * output_options_enabled and PHASE_18's switches the founder flips by SQL).
 * Migration ops_switches_and_audit copies each stored old row to its ops:
 * key once (expand); migration ops_switches_contract (Release 3, Lane 5b)
 * deletes exactly these old keys. A switch with no entry never had another
 * key. PHASE_18's store_audit_enabled is not here: it is a release gate the
 * seed owns (set in growth.ts, applied by pnpm db:seed), not a runtime
 * switch. The seed must never write an old key either (operations.test.ts),
 * so a switch has one home.
 */
export const opsSwitchLegacyKeys = {
  "ops:output_options_enabled": "output_options_enabled",
  "ops:acquisition_paused": "acquisition_paused",
  "ops:free_preview_enabled": "free_preview_enabled",
  "ops:lifecycle_email_enabled": "lifecycle_email_enabled",
  "ops:referrals_enabled": "referrals_enabled",
  "ops:deploy_restarts_enabled": "deploy_restarts_enabled",
  "ops:founding_offer_enabled": "founding_offer_enabled",
} as const satisfies Partial<Record<OpsSwitchKey, string>>;

/** The value type opsSwitch returns for a key. */
export type OpsSwitchValue<K extends OpsSwitchKey> = OpsSwitchValueByKind[(typeof opsSwitchDefaults)[K]["kind"]];

/** True for a key listed in opsSwitchDefaults. */
export function isOpsSwitchKey(key: string): key is OpsSwitchKey {
  return Object.prototype.hasOwnProperty.call(opsSwitchDefaults, key);
}

// End of operator switches.

// ===========================================================================
// Lane 5 Operator basics (p20/ops-basics): P20-66.
// ===========================================================================

/**
 * Caps on operator credit grants (P20-66, apps/web/src/lib/ops/grants.ts).
 * maxCreditsPerGrant bounds one grant or one correction, either sign, so a
 * typo cannot hand out or wipe a large balance. maxCreditsPerMonth bounds
 * every grant together in a calendar month (UTC), counted from the
 * credits.grant rows of ops_audit; corrections that take credits back do
 * not count. A grant over either cap is refused with what is left. Kept in
 * this file rather than credits.ts (the plan's place) so the seed index
 * exports it with no edit to its shared list.
 */
export const opsGrants = { maxCreditsPerMonth: 2000, maxCreditsPerGrant: 600 } as const;

// End of Lane 5 Operator basics.

// ===========================================================================
// Lane 3 Data (p20/data): P20-10, P20-11.
// ===========================================================================

/** The nightly encrypted database backup to R2 (P20-10, decisions 11 and 12). */
export interface BackupPolicy {
  /** Copies under daily/ are deleted by the bucket lifecycle after this many days. */
  dailyKeepDays: number;
  /** Copies under monthly/ (the 1st of each month) after this many days. The
   * privacy page states this, the longest window (P20-23). */
  monthlyKeepDays: number;
  /** The bucket lock on daily/: no copy younger than this can be deleted or
   * overwritten, so a leaked token cannot erase the newest backups. */
  lockDays: number;
  /** Incomplete multipart uploads are aborted after this many days. */
  abortMultipartDays: number;
  /** GET /api/health warns cron_overdue:backup once the newest recorded
   * backup is older than this (a daily job plus slack for a slow run). */
  maxAgeHours: number;
}

/**
 * Backup retention (decision 12). ops/r2/backups-lifecycle.json and
 * ops/r2/backups-lock.json must say the same; a test compares them.
 */
export const backup: BackupPolicy = {
  dailyKeepDays: 35,
  monthlyKeepDays: 180,
  lockDays: 7,
  abortMultipartDays: 1,
  maxAgeHours: 26,
};

/** The founder's restore drill into an isolated database (P20-11). */
export interface RestoreDrillPolicy {
  /** GET /api/health shows restore_drill_overdue (info) once the last
   * passing drill is older than this, or when none was ever recorded. The
   * plan names it healthLimits.drillMaxAgeDays (P20-15); it lives here so the
   * two lanes never edit the same constant, and the Release 2 combine removed
   * the unread healthLimits copy so this is the only one. */
  maxAgeDays: number;
  /** Recovery time objective: the drill reports whether it finished inside
   * this many minutes (docs/ops/BACKUP_RESTORE.md). */
  rtoTargetMinutes: number;
}

export const restoreDrill: RestoreDrillPolicy = {
  maxAgeDays: 35,
  rtoTargetMinutes: 120,
};

// End of Lane 3 Data.

// ===========================================================================
// Lane 5b Deploy (p20/deploy, Release 3): P20-19.
// Planned: deploy = { pendingMaxMinutes, idleWaitMinutes }.
// ===========================================================================

// End of Lane 5b Deploy.

export const deploy = { pendingMaxMinutes: 30, idleWaitMinutes: 20 } as const;

// ===========================================================================
// Lane 8 Runner (p20/runner, Release 3): P20-32 to P20-35.
// Planned: queue, orphan.
// ===========================================================================

// End of Lane 8 Runner.

export const orphan = { heartbeatSeconds: 60, staleHeartbeatMinutes: 5, sweepEverySeconds: 120 } as const;
export const queue = { etaDefaultSeconds: 240, etaSampleSize: 50, maxRunningPerWorkspace: 1 } as const;
export const tick = { everyMinutes: 10, budgetSeconds: 240, leaseMarginSeconds: 60, leaseStuckMinutes: 30, keepaliveTimeoutMs: 5000 } as const;
export const serviceListLimits = { products: 100, assetScan: 600, nearRatio: 0.8 } as const;
export const weeklyReport = { paidPackThreshold: 100, databaseDecisionBytes: 300 * 1024 * 1024, queueDecisionMinutes: 10, storageBudgetSeconds: 20 } as const;

/** Billing views and sends are bounded independently of customer volume. */
export const billingViews = { historyPageSize: 50, invoicePageSize: 24, invoiceCacheMinutes: 5, invoiceCacheCustomers: 100 } as const;
export const billingNoticePolicy = { batchSize: 100, everyMinutes: 1440 } as const;

export const customerSupport = { perUserPerHour: 5, perIpPerHour: 10 } as const;
export const authUi = { resendCooldownSeconds: 60 } as const;
export const followUpPricing = { regenerateFreePerShot: 0 } as const;
export const opsViews = { jobPageSize: 50, timelineRows: 500, overviewRows: 10, signedPhotoSeconds: 300 } as const;

// ===========================================================================
// Lane 10 Schedule (p20/schedule, Release 3): P20-38.
// Planned: tick = { budgetSeconds, leaseStuckMinutes }.
// ===========================================================================

// End of Lane 10 Schedule.

/** Operator alert windows and bounds (P20-47), also used by the queue. */
export const opsAlertPolicy = {
  marginWindowDays: 7,
  failureWindowMinutes: 60,
  failureRate: 0.2,
  minimumFinishedPacks: 5,
  staleHeartbeatMinutes: 10,
  queueWaitMinutes: 10,
  memoryHighTicks: 3,
  signupWindowMinutes: 60,
  signupsPerHour: 20,
  withheldWindowHours: 24,
  withheldGrantsPerDay: 10,
  feedbackWindowDays: 7,
  dedupeMinutes: 60,
  notificationLeaseMinutes: 5,
  maxNotificationsPerTick: 50,
  galleryPageSize: 50,
} as const;
