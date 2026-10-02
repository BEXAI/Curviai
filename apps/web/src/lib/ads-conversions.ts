import { openaiAdsPixelId, parseConsent } from "@/lib/consent";
import { optionalEnv } from "@/lib/env";

/**
 * Server side conversion events for OpenAI Ads (the Conversions API), in
 * the shape Ads Manager shows for each conversion event (checked
 * 2026-10-01): POST https://bzr.openai.com/v1/events?pid=<pixel id> with a
 * Bearer conversion key and { validate_only, events: [{ id, type,
 * timestamp_ms, source_url, action_source: "web", data }] }.
 *
 * Sent only when OPENAI_ADS_CONVERSIONS_KEY is set and the visitor accepted
 * cookies (the same consent the pixel waits for). It never throws and never
 * waits longer than ADS_CONVERSION_TIMEOUT_MS, so tracking can never break
 * the request it rides on. The key is never logged.
 */

export const ADS_EVENTS_URL = "https://bzr.openai.com/v1/events";
export const ADS_CONVERSION_TIMEOUT_MS = 3000;

export interface AdsConversion {
  /** Stable id, so a repeat of the same conversion is not counted twice. */
  id: string;
  /** The conversion event's base event, e.g. "registration_completed". */
  type: string;
  sourceUrl: string;
  data: Record<string, unknown>;
  timestampMs?: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** True when the Cookie header says the visitor accepted cookies. */
export function adsConsentGranted(cookieHeader: string | null | undefined): boolean {
  return parseConsent(cookieHeader) === "granted";
}

/** Sends one conversion; returns whether OpenAI accepted it. */
export async function sendAdsConversion(
  event: AdsConversion,
  opts: { cookieHeader: string | null | undefined; fetchFn?: FetchLike; env?: Record<string, string | undefined> },
): Promise<boolean> {
  const key = opts.env ? opts.env.OPENAI_ADS_CONVERSIONS_KEY : optionalEnv("OPENAI_ADS_CONVERSIONS_KEY");
  const pixelId = openaiAdsPixelId();
  if (!key || !pixelId || !adsConsentGranted(opts.cookieHeader)) {
    return false;
  }
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${ADS_EVENTS_URL}?pid=${encodeURIComponent(pixelId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        validate_only: false,
        events: [
          {
            id: event.id,
            type: event.type,
            timestamp_ms: event.timestampMs ?? Date.now(),
            source_url: event.sourceUrl,
            action_source: "web",
            data: event.data,
          },
        ],
      }),
      signal: AbortSignal.timeout(ADS_CONVERSION_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[ads] conversion ${event.type} refused with status ${response.status}`);
    }
    return response.ok;
  } catch (err) {
    console.warn(`[ads] conversion ${event.type} not sent`, err instanceof Error ? err.name : "error");
    return false;
  }
}

/** How recent an account must be for its first confirmed sign in to count as a registration. */
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The Registration Completed conversion for a newly created account, or null for an older one. */
export function registrationConversion(
  user: { id: string; created_at?: string | null },
  sourceUrl: string,
  now: number = Date.now(),
): AdsConversion | null {
  const created = user.created_at ? Date.parse(user.created_at) : Number.NaN;
  if (!Number.isFinite(created) || now - created > REGISTRATION_WINDOW_MS) {
    return null;
  }
  return {
    id: `registration_completed:${user.id}`,
    type: "registration_completed",
    sourceUrl,
    data: { type: "customer_action" },
    timestampMs: now,
  };
}
