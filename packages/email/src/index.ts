/**
 * @curvi/email: Curvi's lifecycle email (docs/phases/PHASE_18.md P18-06 and
 * P18-07) over Resend's REST API (founder decision 3). Used by the web
 * app's cron, unsubscribe and webhook routes; server only (node:crypto).
 */

export * from "./config";
export * from "./copy";
export * from "./keys";
export * from "./links";
export * from "./render";
export * from "./resend";
export * from "./send";
export * from "./store";
// P18-07: the lifecycle emails, their selection and the cron run.
export * from "./due";
export * from "./facts";
export * from "./run";
export * from "./templates";
