import { freePreview, storeAudit } from "./growth";

/**
 * Data retention seed (docs/phases/PHASE_20.md, "Seed summary"): how long
 * each table, counter family and abuse fallback keeps its rows. The windows
 * live here, never in the retention code (CLAUDE.md rule 2). The older
 * retention.ts seed is about cancel flow save offers, not data.
 *
 * Empty in the contract commit. One section per lane below, so lanes never
 * edit the same lines.
 *
 * Pure data only: this module is bundled into client pages through
 * @curvi/pipeline/seed.
 */

// ===========================================================================
// Lane 10 Schedule (p20/schedule, Release 3): P20-39.
// Planned: the windows for events, ops_audit, job_steps, spend_cap_counters
// by key family, site_visits, upload_preflights, ops_alerts and email_sends.
// ===========================================================================

// End of Lane 10 Schedule.

// ===========================================================================
// Lane 15 Security (p20/security, Release 4): P20-29.
// Planned: turnstileFallback.
// ===========================================================================

// End of Lane 15 Security.

/** Never delete funnel first-event claims or billing consent rows here. */
export const dataRetention = {
  batchSize: 5000, budgetSeconds: 20,
  eventsDays: 180, billingEventsDays: 400, opsAuditDays: 400, jobStepsDays: 180,
  siteVisitsDays: 400, uploadPreflightsDays: 30, resolvedAlertsDays: 180, expiredBreakerDays: 1,
  counterDays: {
    "caps:asset:": 14, "caps:pack:": 14, "caps:workspace:": 90, "caps:global:": 90,
    "caps:alert:": 90, "alerts:": 90, "preview:": 30, "csp|": 90, "llm|": 400,
  },
  otherCounterDays: 90,
} as const;
export const tmpObjectDays = 7;

/** Missing both challenge keys leaves a bounded fallback; half configuration fails closed. */
export const turnstileFallback = {
  previewPerIpPerDay: Math.max(1, Math.floor(freePreview.perIpPerDay / 2)),
  previewSitePerDay: Math.max(1, Math.floor(freePreview.sitePerDay / 2)),
  storeAuditsPerIpPerHour: Math.max(1, Math.floor(storeAudit.auditsPerIpPerHour / 2)),
  storeAuditsPerDay: Math.max(1, Math.floor(storeAudit.auditsPerDay / 2)),
} as const;
