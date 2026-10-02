/**
 * Central env access. Nothing else in the app reads process.env directly.
 * Reads happen at call time, never at import time, so the app builds and the
 * marketing site runs with no env configured at all.
 */

import { billingReadiness } from "@/lib/billing/readiness";

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_URL") && optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
}

/**
 * A Stripe secret key is set: enough for read only Stripe calls (webhook
 * lookups, the portal, the cancel flow, account deletion). Never use it to
 * decide whether to sell: a key alone cannot grant credits (P20-01).
 */
export function hasStripeApiKey(): boolean {
  return Boolean(optionalEnv("STRIPE_SECRET_KEY"));
}

/**
 * Checkout is open: the secret key, the webhook signing secret and every
 * self serve price are set, in a key mode that fits this environment
 * (lib/billing/readiness.ts, P20-01). Every selling surface reads this.
 */
export function isCheckoutOpen(): boolean {
  return billingReadiness(optionalEnv).checkoutOpen;
}

export function isR2Configured(): boolean {
  return Boolean(
    optionalEnv("R2_ACCOUNT_ID") && optionalEnv("R2_ACCESS_KEY_ID") && optionalEnv("R2_SECRET_ACCESS_KEY"),
  );
}

export function siteUrl(): string {
  return optionalEnv("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000";
}
