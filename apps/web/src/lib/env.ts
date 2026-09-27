/**
 * Central env access. Nothing else in the app reads process.env directly.
 * Reads happen at call time, never at import time, so the app builds and the
 * marketing site runs with no env configured at all.
 */

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

export function isStripeConfigured(): boolean {
  return Boolean(optionalEnv("STRIPE_SECRET_KEY"));
}

export function isR2Configured(): boolean {
  return Boolean(
    optionalEnv("R2_ACCOUNT_ID") && optionalEnv("R2_ACCESS_KEY_ID") && optionalEnv("R2_SECRET_ACCESS_KEY"),
  );
}

export function siteUrl(): string {
  return optionalEnv("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000";
}
