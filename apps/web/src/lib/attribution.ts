/**
 * First touch attribution (docs/phases/PHASE_18.md P18-01), the client safe
 * part. Landing parameters travel on links, never in storage before
 * consent: readLandingParams keeps only the attribution keys of a URL,
 * cleaned and capped, and withLandingParams carries them onto a signup link
 * without overriding what the link already says. No emails or free text
 * survive.
 *
 * Value formats every lane codes against:
 * - utm_source, utm_medium, utm_campaign, utm_content, utm_term: lower case,
 *   at most 100 characters (the visitor count's cleanUtm), never an email.
 * - source: a seeded page source key (signupSourceKeys or one of the
 *   signupSourcePrefixes families in packages/pipeline/src/seed/growth.ts).
 * - ref: a referral code (P18-24), 4 to 32 lower case letters and digits.
 * - s: a share slug (P18-14), 4 to 32 lower case letters and digits.
 * - claim: a prospect claim token (P18-04), 16 to 64 lower case letters and
 *   digits, so tokens are hex or lower case base32 (case is dropped here).
 * - preview: a free preview id (P18-12), a UUID.
 *
 * Pure and dependency light, so the signup link, the signup form and the
 * auth callback can all use it.
 */

import {
  channelChoices,
  firstTouchCookieDays,
  isSellerCategoryKey,
  isSignupSourceChoiceKey,
  isSignupSourceKey,
} from "@curvi/pipeline/seed";
import { parseConsent, type ConsentChoice } from "@/lib/consent";
import { parseSignupSource } from "@/lib/safe-next";
import { cleanUtm, normalizePath, referrerHost } from "@/lib/visits/normalize";

export const UTM_PARAM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/** The only query parameters attribution reads, in the order links carry them. */
export const LANDING_PARAM_KEYS = [...UTM_PARAM_KEYS, "ref", "source", "s", "claim", "preview"] as const;

export type LandingParamKey = (typeof LANDING_PARAM_KEYS)[number];
export type LandingParams = Partial<Record<LandingParamKey, string>>;

/**
 * What the signup form sends as the attribution hint in the signup metadata
 * (and, for Google sign in, as the base64url attr parameter on the callback
 * URL). The server validates it again before writing signup_attributions
 * (Lane 1); nothing here is trusted on its own.
 */
export interface SignupAttributionHint extends LandingParams {
  /** From the curvi_ft first touch cookie, written only after consent. */
  referrer_host?: string;
  landing_path?: string;
  /** ISO 8601. */
  first_seen_at?: string;
  /** A seeded signupSourceChoices key, and the short text for "Other". */
  self_reported?: string;
  self_reported_other?: string;
  /** The cookie choice when the form was sent; null before any choice. */
  consent?: ConsentChoice | null;
}

const SHORT_TOKEN = /^[a-z0-9]{4,32}$/;
const CLAIM_TOKEN = /^[a-z0-9]{16,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function lowerTrim(raw: unknown): string | null {
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

function matching(raw: unknown, pattern: RegExp): string | null {
  const value = lowerTrim(raw);
  return value && pattern.test(value) ? value : null;
}

/** One landing parameter, cleaned, or null when it is empty or not allowed. */
export function cleanLandingValue(key: LandingParamKey, raw: unknown): string | null {
  switch (key) {
    case "utm_source":
    case "utm_medium":
    case "utm_campaign":
    case "utm_content":
    case "utm_term": {
      const value = cleanUtm(raw);
      return value && !value.includes("@") ? value : null;
    }
    case "source": {
      const value = typeof raw === "string" ? parseSignupSource(raw) : null;
      return value && isSignupSourceKey(value) ? value : null;
    }
    case "ref":
    case "s":
      return matching(raw, SHORT_TOKEN);
    case "claim":
      return matching(raw, CLAIM_TOKEN);
    case "preview":
      return matching(raw, UUID);
  }
}

/**
 * The attribution keys of a page URL (absolute or relative, or its search
 * params), cleaned. Every other parameter is dropped. Never throws.
 */
export function readLandingParams(input: URL | URLSearchParams | string | null | undefined): LandingParams {
  let search: URLSearchParams;
  try {
    if (input instanceof URLSearchParams) {
      search = input;
    } else if (input instanceof URL) {
      search = input.searchParams;
    } else if (typeof input === "string" && input.length > 0) {
      search = new URL(input, "https://curvi.invalid").searchParams;
    } else {
      return {};
    }
  } catch {
    return {};
  }
  const params: LandingParams = {};
  for (const key of LANDING_PARAM_KEYS) {
    const value = cleanLandingValue(key, search.get(key));
    if (value) {
      params[key] = value;
    }
  }
  return params;
}

/**
 * The href with each landing parameter the link does not already carry
 * appended (values the link sets itself win). Keeps a relative href
 * relative and keeps its fragment.
 */
export function withLandingParams(href: string, params: LandingParams): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const search = new URLSearchParams(queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "");
  for (const key of LANDING_PARAM_KEYS) {
    const value = cleanLandingValue(key, params[key]);
    if (value && !search.has(key)) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

/** Extra values a signup link can carry beyond plan, cadence and source. */
export const SIGNUP_EXTRA_KEYS = ["s", "claim", "preview", "ref", "category", "channel"] as const;

export type SignupExtraKey = (typeof SIGNUP_EXTRA_KEYS)[number];
export type SignupLinkExtra = Partial<Record<SignupExtraKey, string>>;

const CHANNEL_VALUES: readonly string[] = channelChoices.map((choice) => choice.value);

/**
 * One signup link extra, cleaned, or null. channel must be a seeded
 * channelChoices value and category a seeded sellerCategories key (P18-20),
 * so a category page whose slug is not a seller category (sports) simply
 * preselects nothing.
 */
export function cleanSignupExtra(key: SignupExtraKey, raw: unknown): string | null {
  switch (key) {
    case "s":
    case "claim":
    case "preview":
    case "ref":
      return cleanLandingValue(key, raw);
    case "category": {
      const value = matching(raw, KEY);
      return value && isSellerCategoryKey(value) ? value : null;
    }
    case "channel": {
      const value = lowerTrim(raw);
      return value && CHANNEL_VALUES.includes(value) ? value : null;
    }
  }
}

// ---------------------------------------------------------------------------
// First touch cookie and the signup hint (Lane 1, P18-01).
// ---------------------------------------------------------------------------

/**
 * The first touch cookie (founder decision 2): the landing parameters, the
 * referring host, the landing path and the time of the first page a
 * visitor saw, written only after they accept cookies and never
 * overwritten. First party, SameSite Lax, at most FIRST_TOUCH_MAX_BYTES.
 */
export const FIRST_TOUCH_COOKIE = "curvi_ft";
export const FIRST_TOUCH_MAX_BYTES = 1024;
export const MAX_LANDING_PATH_LENGTH = 200;
export const MAX_REFERRER_HOST_LENGTH = 100;
export const MAX_SELF_REPORTED_OTHER_LENGTH = 80;

export interface FirstTouch extends LandingParams {
  referrer_host?: string;
  landing_path?: string;
  /** ISO 8601. */
  first_seen_at: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** A first touch time this far in the future is a broken clock, not a visit. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** A landing path as stored: the visitor count's normalizePath (no query,
 * ids as :id), at most MAX_LANDING_PATH_LENGTH characters. */
export function cleanLandingPath(raw: unknown): string | null {
  const path = normalizePath(raw);
  return path ? path.slice(0, MAX_LANDING_PATH_LENGTH) : null;
}

/** A host name as stored (already reduced from a URL), or null. */
export function cleanReferrerHost(raw: unknown): string | null {
  const value = lowerTrim(raw)?.replace(/^www\./, "");
  return value && value.length <= MAX_REFERRER_HOST_LENGTH && HOST.test(value) ? value : null;
}

/** An ISO time no later than a day after now and no earlier than the
 * cookie can live, or null. */
export function cleanFirstSeenAt(raw: unknown, now: Date = new Date()): string | null {
  if (typeof raw !== "string" || raw.length > 40) {
    return null;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return null;
  }
  const oldest = now.getTime() - (firstTouchCookieDays + 1) * 24 * 60 * 60 * 1000;
  if (at > now.getTime() + FUTURE_SLACK_MS || at < oldest) {
    return null;
  }
  return new Date(at).toISOString();
}

/** The short "Other" answer: one line, at most 80 characters, never an
 * email address. */
export function cleanSelfReportedOther(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SELF_REPORTED_OTHER_LENGTH).trim();
  return value.length > 0 && !EMAIL_LIKE.test(value) ? value : null;
}

/** Only the landing parameter keys of an object, cleaned. */
function cleanLandingObject(raw: Record<string, unknown>): LandingParams {
  const params: LandingParams = {};
  for (const key of LANDING_PARAM_KEYS) {
    const value = cleanLandingValue(key, raw[key]);
    if (value) {
      params[key] = value;
    }
  }
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first touch of the page a visitor first saw in this browser:
 * its landing parameters, the host that sent them (never this site) and its
 * path. ownHosts are this site's hosts.
 */
export function buildFirstTouch(input: {
  href: string;
  referrer: string | null | undefined;
  ownHosts: readonly string[];
  now?: Date;
}): FirstTouch {
  const touch: FirstTouch = {
    ...readLandingParams(input.href),
    first_seen_at: (input.now ?? new Date()).toISOString(),
  };
  const host = cleanReferrerHost(referrerHost(input.referrer, input.ownHosts));
  if (host) {
    touch.referrer_host = host;
  }
  let path: string | null = null;
  try {
    path = cleanLandingPath(new URL(input.href, "https://curvi.invalid").pathname);
  } catch {
    path = null;
  }
  if (path) {
    touch.landing_path = path;
  }
  return touch;
}

/** A first touch object from anywhere (the cookie, a hint), cleaned, or
 * null when it has no valid time. */
export function cleanFirstTouch(raw: unknown, now: Date = new Date()): FirstTouch | null {
  if (!isRecord(raw)) {
    return null;
  }
  const firstSeenAt = cleanFirstSeenAt(raw.first_seen_at, now);
  if (!firstSeenAt) {
    return null;
  }
  const touch: FirstTouch = { ...cleanLandingObject(raw), first_seen_at: firstSeenAt };
  const host = cleanReferrerHost(raw.referrer_host);
  if (host) {
    touch.referrer_host = host;
  }
  const path = cleanLandingPath(raw.landing_path);
  if (path) {
    touch.landing_path = path;
  }
  return touch;
}

/**
 * The Set-Cookie style string that stores a first touch, or null when it
 * would pass FIRST_TOUCH_MAX_BYTES (nothing is stored then).
 */
export function firstTouchCookieString(touch: FirstTouch, secure: boolean): string | null {
  const value = encodeURIComponent(JSON.stringify(touch));
  if (value.length + FIRST_TOUCH_COOKIE.length + 1 > FIRST_TOUCH_MAX_BYTES) {
    return null;
  }
  return [
    `${FIRST_TOUCH_COOKIE}=${value}`,
    "Path=/",
    `Max-Age=${firstTouchCookieDays * 24 * 60 * 60}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The string that deletes the first touch cookie. */
export function clearFirstTouchCookieString(secure: boolean): string {
  return [`${FIRST_TOUCH_COOKIE}=`, "Path=/", "Max-Age=0", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");
}

/** The first touch in a Cookie header or document.cookie string, cleaned. */
export function parseFirstTouch(cookieString: string | null | undefined, now: Date = new Date()): FirstTouch | null {
  for (const part of (cookieString ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== FIRST_TOUCH_COOKIE) {
      continue;
    }
    try {
      return cleanFirstTouch(JSON.parse(decodeURIComponent(rest.join("="))), now);
    } catch {
      return null;
    }
  }
  return null;
}

/** Keys the signup link itself decides: the page the visitor clicked on and
 * the flow it starts (a share, a claim, a preview, a referral). */
const LINK_KEYS = ["source", "s", "claim", "preview", "ref"] as const;

/**
 * The attribution hint the signup form sends in the signup metadata. The
 * signup page's own parameters say which link was clicked (source, share
 * slug, claim, preview, ref); the first touch, when there is one, decides the
 * campaign (all UTM tags from one touch, never mixed) and alone gives the
 * referring host, landing path and first seen time.
 */
export function signupAttributionHint(input: {
  page: LandingParams;
  firstTouch: FirstTouch | null;
  selfReported?: string | null;
  selfReportedOther?: string | null;
  consent: ConsentChoice | null;
}): SignupAttributionHint {
  const page = cleanLandingObject(input.page as Record<string, unknown>);
  const touch = input.firstTouch;
  const hint: SignupAttributionHint = {};
  for (const key of LINK_KEYS) {
    const value = page[key] ?? touch?.[key];
    if (value) {
      hint[key] = value;
    }
  }
  const touchHasUtm = Boolean(touch && UTM_PARAM_KEYS.some((key) => touch[key]));
  const utmFrom: LandingParams = touchHasUtm && touch ? touch : page;
  for (const key of UTM_PARAM_KEYS) {
    if (utmFrom[key]) {
      hint[key] = utmFrom[key];
    }
  }
  if (touch?.referrer_host) {
    hint.referrer_host = touch.referrer_host;
  }
  if (touch?.landing_path) {
    hint.landing_path = touch.landing_path;
  }
  if (touch?.first_seen_at) {
    hint.first_seen_at = touch.first_seen_at;
  }
  if (isSignupSourceChoiceKey(input.selfReported)) {
    hint.self_reported = input.selfReported;
    const other = input.selfReported === "other" ? cleanSelfReportedOther(input.selfReportedOther) : null;
    if (other) {
      hint.self_reported_other = other;
    }
  }
  hint.consent = input.consent === "granted" || input.consent === "denied" ? input.consent : null;
  return hint;
}

/**
 * The hint as the server keeps it: every known key cleaned again with the
 * same rules and caps, everything else dropped. The browser and the user
 * can edit signup metadata, so nothing in it is trusted as sent.
 */
export function cleanSignupAttributionHint(raw: unknown, now: Date = new Date()): SignupAttributionHint {
  if (!isRecord(raw)) {
    return {};
  }
  const hint: SignupAttributionHint = cleanLandingObject(raw);
  const host = cleanReferrerHost(raw.referrer_host);
  if (host) {
    hint.referrer_host = host;
  }
  const path = cleanLandingPath(raw.landing_path);
  if (path) {
    hint.landing_path = path;
  }
  const firstSeenAt = cleanFirstSeenAt(raw.first_seen_at, now);
  if (firstSeenAt) {
    hint.first_seen_at = firstSeenAt;
  }
  if (isSignupSourceChoiceKey(raw.self_reported)) {
    hint.self_reported = raw.self_reported;
    const other = raw.self_reported === "other" ? cleanSelfReportedOther(raw.self_reported_other) : null;
    if (other) {
      hint.self_reported_other = other;
    }
  }
  hint.consent = raw.consent === "granted" || raw.consent === "denied" ? raw.consent : null;
  return hint;
}

/** The hint as a base64url JSON value, for the attr parameter Google sign in
 * (P18-13) puts on the callback URL, where no signup metadata exists. */
export function encodeAttributionParam(hint: SignupAttributionHint): string {
  const bytes = new TextEncoder().encode(JSON.stringify(hint));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The attr parameter read back, or null when it is missing, too long or
 * not base64url JSON. The result still goes through
 * cleanSignupAttributionHint. */
export function decodeAttributionParam(raw: string | null | undefined): unknown {
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * In the browser: the hint for the signup being sent now, from this page's
 * URL, the first touch cookie and the cookie choice. Empty on the server.
 */
export function collectSignupAttribution(answer: { selfReported?: string | null; other?: string | null }): SignupAttributionHint {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  const consent = parseConsent(document.cookie);
  return signupAttributionHint({
    page: readLandingParams(window.location.href),
    // The cookie only exists after consent; a withdrawn choice ignores it.
    firstTouch: consent === "granted" ? parseFirstTouch(document.cookie) : null,
    selfReported: answer.selfReported ?? null,
    selfReportedOther: answer.other ?? null,
    consent,
  });
}
