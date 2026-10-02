import { optionalEnv } from "@/lib/env";

export const TURNSTILE_MESSAGE = "We could not check that you are a person. Please try again.";
export function turnstileMode(): "configured" | "fallback" | "misconfigured" {
  const site = optionalEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  const secret = optionalEnv("TURNSTILE_SECRET_KEY");
  return site && secret ? "configured" : site || secret ? "misconfigured" : "fallback";
}

export async function verifyTurnstile(token: unknown, expected: { action: string; hostname: string; ip?: string }, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const secret = optionalEnv("TURNSTILE_SECRET_KEY");
  if (!secret || typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(expected.ip && expected.ip !== "unknown" ? { remoteip: expected.ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { success?: boolean; hostname?: string; action?: string };
    return body.success === true && body.hostname === expected.hostname && body.action === expected.action;
  } catch { return false; }
}
