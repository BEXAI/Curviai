/**
 * The body of one visit beacon (components/visit-beacon.tsx). Client safe:
 * no imports. It carries the page path, the UTM tags of the address if any,
 * and on the first page view after a full page load only, the referrer the
 * browser reports. Nothing else about the browser is read or sent.
 */

export const VISITS_ENDPOINT = "/api/visits";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;
const MAX_VALUE_LENGTH = 200;

export interface VisitPayload {
  path: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

export function buildVisitPayload(
  location: { pathname: string; search: string },
  referrer: string | null,
): VisitPayload {
  const payload: VisitPayload = { path: location.pathname.slice(0, 1000) };
  if (referrer) {
    payload.referrer = referrer.slice(0, 1000);
  }
  const params = new URLSearchParams(location.search);
  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim();
    if (value) {
      payload[key] = value.slice(0, MAX_VALUE_LENGTH);
    }
  }
  return payload;
}
