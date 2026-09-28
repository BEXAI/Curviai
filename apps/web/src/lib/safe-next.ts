/**
 * Same origin redirect targets and the pricing intent that rides through
 * signup (Update.md 4.3). Every place that sends a browser to a caller
 * supplied path (the auth callback, the auth form and the middleware) goes
 * through safeNextPath, so a crafted link can never bounce a freshly signed
 * in user to another site.
 *
 * Pure and dependency free apart from the tiers seed, so the middleware, the
 * browser form and the route handlers can all share it.
 */

import { tiers } from "@curvi/pipeline/seed";

export const DEFAULT_NEXT_PATH = "/app";

const MAX_NEXT_LENGTH = 2048;

// C0 controls, DEL and C1 controls. The URL parser silently strips tab and
// newline characters, so "/\t/evil.com" would otherwise resolve to
// "//evil.com" and leave the site.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

function looksUnsafe(value: string): boolean {
  return value.includes("\\") || CONTROL_CHARACTERS.test(value) || value.startsWith("//");
}

/**
 * Returns a same origin path (pathname, search and hash) for a raw next
 * value, or the fallback. Rejects anything that does not start with a single
 * slash, anything with a backslash or a control character (raw or percent
 * encoded), and anything the URL parser resolves to another origin or to a
 * protocol relative path.
 */
export function safeNextPath(
  raw: string | null | undefined,
  origin: string,
  fallback: string = DEFAULT_NEXT_PATH,
): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT_LENGTH) {
    return fallback;
  }
  if (!raw.startsWith("/") || looksUnsafe(raw)) {
    return fallback;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (looksUnsafe(decoded)) {
    return fallback;
  }
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(origin);
    resolved = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (resolved.origin !== base.origin) {
    return fallback;
  }
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  // Dot segments can collapse "/.//evil.com" into "//evil.com", which a later
  // redirect would treat as protocol relative.
  if (!path.startsWith("/") || looksUnsafe(path)) {
    return fallback;
  }
  return path;
}

export type BillingCadence = "monthly" | "annual";

export interface CheckoutIntent {
  plan: string;
  cadence: BillingCadence;
}

/** Paid tiers from the seed; the free tier never needs a checkout. */
function paidTier(plan: string) {
  return tiers.find((tier) => tier.key === plan && tier.monthlyUsd > 0) ?? null;
}

/**
 * Validates a plan and cadence pair from the pricing page against the tiers
 * seed. The plan must be a paid tier. A missing cadence means monthly; an
 * unknown cadence, or annual on a tier with no annual price, is rejected so
 * the buyer never lands on a checkout for something they did not pick.
 */
export function parseCheckoutIntent(
  plan: string | null | undefined,
  cadence: string | null | undefined,
): CheckoutIntent | null {
  if (!plan) {
    return null;
  }
  const tier = paidTier(plan.trim().toLowerCase());
  if (!tier) {
    return null;
  }
  const wanted = (cadence ?? "monthly").trim().toLowerCase() || "monthly";
  if (wanted === "monthly") {
    return { plan: tier.key, cadence: "monthly" };
  }
  if (wanted === "annual" && tier.annualUsdPerMonth > 0) {
    return { plan: tier.key, cadence: "annual" };
  }
  return null;
}

/** Where the billing page picks up a plan chosen before signup. */
export function checkoutPath(intent: CheckoutIntent): string {
  const params = new URLSearchParams({ checkout: intent.plan, cadence: intent.cadence });
  return `/app/billing?${params.toString()}`;
}

/** Signup attribution is a short label such as "pricing"; anything else is dropped. */
export function parseSignupSource(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value) ? value : null;
}

export interface PostAuthParams {
  next?: string | null;
  plan?: string | null;
  cadence?: string | null;
}

/**
 * Where a user goes after signup, login or an email confirmation link: the
 * billing checkout for a valid pricing intent, otherwise the safe next path,
 * otherwise the dashboard.
 */
export function postAuthDestination(params: PostAuthParams, origin: string): string {
  const intent = parseCheckoutIntent(params.plan, params.cadence);
  if (intent) {
    return checkoutPath(intent);
  }
  return safeNextPath(params.next, origin);
}

/** Reads next, plan and cadence from a query string. */
export function postAuthParamsFrom(search: URLSearchParams): PostAuthParams {
  return { next: search.get("next"), plan: search.get("plan"), cadence: search.get("cadence") };
}

/**
 * Error codes the auth callback may put on /login. The form shows only these
 * fixed messages, so a crafted ?error= link cannot put arbitrary text on the
 * login page.
 */
export const AUTH_ERROR_MESSAGES = {
  link_invalid: "That sign in link has expired or was already used. Log in, or request a new link.",
  unavailable: "Sign in is not available right now. Please try again in a few minutes.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

function isAuthErrorCode(code: string): code is AuthErrorCode {
  // Own keys only: "constructor", "__proto__" or "toString" are inherited
  // from Object.prototype and would hand the form a function or an object
  // instead of a message.
  return Object.hasOwn(AUTH_ERROR_MESSAGES, code);
}

/** The fixed message for an ?error= code; anything unknown reads as an
 * expired link. Always a string, never a value from the prototype chain. */
export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  return isAuthErrorCode(code) ? AUTH_ERROR_MESSAGES[code] : AUTH_ERROR_MESSAGES.link_invalid;
}

function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * The note above the signup and login form for a plan picked on the pricing
 * page. It names the plan without promising a checkout page: without Stripe
 * the billing page takes an upgrade request instead, and this stays true
 * either way.
 */
export function planIntentNote(mode: "signup" | "login", intent: CheckoutIntent): string {
  const action = mode === "signup" ? "Create your account" : "Log in";
  const billed = intent.cadence === "annual" ? "annually" : "monthly";
  return `${action} to continue to the ${planLabel(intent.plan)} plan, billed ${billed}.`;
}

/** The message after signup when the email still needs confirming. */
export function confirmationSentMessage(intent: CheckoutIntent | null): string {
  const next = intent
    ? `we will take you to the ${planLabel(intent.plan)} plan on your billing page`
    : "your workspace will be ready";
  return `Almost there. We sent a confirmation link to your inbox. Open it on this device and ${next}. Check spam if it does not arrive in a minute.`;
}
