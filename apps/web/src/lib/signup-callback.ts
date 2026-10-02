/**
 * What travels from the signup and login forms, through Supabase, to
 * /auth/callback (docs/phases/PHASE_18.md P18-13, with P18-01, P18-12 and
 * P18-20 reading it).
 *
 * The callback URL a form hands Supabase (emailRedirectTo for an email
 * signup, redirectTo for Google) carries:
 * - next: where the user was heading (safeNextPath again at the callback);
 * - attr: the attribution hint as base64url JSON (P18-01). An email signup
 *   also stores the hint in its signup metadata (Lane 1); a Google signup
 *   has no form metadata, so attr is its only carrier. The callback reads
 *   attr first and the metadata second;
 * - category and channel: the answers a category or channel page
 *   preselected (P18-20), forwarded to /welcome by the callback;
 * - via=google on the Google redirect only, so a refused or canceled Google
 *   return (?error= with no code) can say so, while an expired email
 *   confirmation or reset link, which Supabase's PKCE flow also returns as
 *   ?error=, gets the expired link message instead.
 *
 * Nothing here is trusted on its own: every value is cleaned again when it
 * is read, and a value that does not fit is dropped, never stored. The user
 * can edit both the URL and the metadata, so these are hints only.
 *
 * Pure and client safe: the forms build the URL and the callback route
 * reads it with the same functions.
 */

import { cleanLandingValue, cleanSignupExtra, LANDING_PARAM_KEYS, type SignupAttributionHint } from "@/lib/attribution";

/** The callback query parameter that holds the attribution hint. */
export const ATTR_PARAM = "attr";

/** The callback query parameter that marks a Google sign in's return. */
export const VIA_PARAM = "via";

/** Longest attr value read; anything longer is dropped whole. The cleaned
 * hint is a few hundred characters at most. */
export const MAX_ATTR_PARAM_LENGTH = 2048;

/** How the account was made: the first provider Supabase recorded. */
export type SignupMethod = "email" | "google";

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HOST = /^(?=.{1,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_LANDING_PATH = 200;
const MAX_OTHER_TEXT = 80;

/** A same site path with no query or fragment, at most 200 characters. */
function cleanLandingPath(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const path = raw.trim().split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > MAX_LANDING_PATH) {
    return null;
  }
  // Printable ASCII only, no spaces or backslashes.
  return /^\/[\x21-\x5b\x5d-\x7e]*$/.test(path) ? path : null;
}

/** A valid date, written back as ISO 8601. */
function cleanTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) {
    return null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The short "Other" answer: plain text on one line, at most 80
 * characters, never an email address. */
function cleanOtherText(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_OTHER_TEXT)
    .trim();
  return text && !text.includes("@") ? text : null;
}

/**
 * The attribution hint with every value cleaned and capped, or null when
 * nothing usable is left. Unknown keys are dropped. Lane 1's server side
 * validator (signup_attributions) applies the same caps; the self reported
 * key is narrowed to the seeded choices there.
 */
export function cleanAttributionHint(raw: unknown): SignupAttributionHint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const hint: SignupAttributionHint = {};
  for (const key of LANDING_PARAM_KEYS) {
    const value = cleanLandingValue(key, input[key]);
    if (value) {
      hint[key] = value;
    }
  }
  const host = typeof input.referrer_host === "string" ? input.referrer_host.trim().toLowerCase() : "";
  if (HOST.test(host)) {
    hint.referrer_host = host;
  }
  const landingPath = cleanLandingPath(input.landing_path);
  if (landingPath) {
    hint.landing_path = landingPath;
  }
  const firstSeen = cleanTimestamp(input.first_seen_at);
  if (firstSeen) {
    hint.first_seen_at = firstSeen;
  }
  const selfReported = typeof input.self_reported === "string" ? input.self_reported.trim().toLowerCase() : "";
  if (KEY.test(selfReported)) {
    hint.self_reported = selfReported;
  }
  const other = cleanOtherText(input.self_reported_other);
  if (other) {
    hint.self_reported_other = other;
  }
  if (input.consent === "granted" || input.consent === "denied") {
    hint.consent = input.consent;
  }
  return Object.keys(hint).length > 0 ? hint : null;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The cleaned hint as a base64url attr value, or null when it is empty. */
export function encodeAttributionParam(hint: SignupAttributionHint | null | undefined): string | null {
  const clean = cleanAttributionHint(hint);
  if (!clean) {
    return null;
  }
  const encoded = toBase64Url(JSON.stringify(clean));
  return encoded.length <= MAX_ATTR_PARAM_LENGTH ? encoded : null;
}

/** The hint an attr value carries, cleaned; null for anything malformed,
 * oversized or empty. Never throws. */
export function decodeAttributionParam(raw: string | null | undefined): SignupAttributionHint | null {
  if (!raw || raw.length > MAX_ATTR_PARAM_LENGTH || !BASE64URL.test(raw)) {
    return null;
  }
  try {
    return cleanAttributionHint(JSON.parse(fromBase64Url(raw)));
  } catch {
    return null;
  }
}

/** The welcome answers a category or channel page preselected (P18-20):
 * a seeded sellerCategories key and a seeded channelChoices value. */
export interface SignupProfileHint {
  category?: string;
  channel?: string;
}

/** category and channel from a query string, each cleaned against the seed
 * (cleanSignupExtra); anything else is dropped. */
export function profileHintFrom(search: URLSearchParams | { get(key: string): string | null }): SignupProfileHint {
  const hint: SignupProfileHint = {};
  const category = cleanSignupExtra("category", search.get("category"));
  if (category) {
    hint.category = category;
  }
  const channel = cleanSignupExtra("channel", search.get("channel"));
  if (channel) {
    hint.channel = channel;
  }
  return hint;
}

export interface SignupCallbackInput {
  /** Where to go after the callback; safeNextPath runs again there. */
  next: string;
  attribution?: SignupAttributionHint | null;
  profile?: SignupProfileHint | null;
  /** Set for the Google redirect (P18-13). */
  via?: "google";
}

/** The /auth/callback URL a form hands Supabase. */
export function signupCallbackUrl(origin: string, input: SignupCallbackInput): string {
  const url = new URL("/auth/callback", origin);
  url.searchParams.set("next", input.next);
  const attr = encodeAttributionParam(input.attribution);
  if (attr) {
    url.searchParams.set(ATTR_PARAM, attr);
  }
  const category = cleanSignupExtra("category", input.profile?.category);
  if (category) {
    url.searchParams.set("category", category);
  }
  const channel = cleanSignupExtra("channel", input.profile?.channel);
  if (channel) {
    url.searchParams.set("channel", channel);
  }
  if (input.via === "google") {
    url.searchParams.set(VIA_PARAM, "google");
  }
  return url.toString();
}

interface CallbackUser {
  app_metadata?: { provider?: unknown } | null;
  user_metadata?: Record<string, unknown> | null;
}

/** google when Supabase recorded Google as the provider the account was
 * made with (app_metadata.provider, which only the service role can
 * change), email otherwise. A password account that later links Google
 * stays email. */
export function signupMethodOf(user: CallbackUser | null | undefined): SignupMethod {
  return user?.app_metadata?.provider === "google" ? "google" : "email";
}

export interface SignupCallbackContext {
  method: SignupMethod;
  /** attr from the callback URL, else the signup metadata hint; cleaned. */
  attribution: SignupAttributionHint | null;
  /** The welcome answers to preselect (P18-20). */
  profile: SignupProfileHint;
}

/** What /auth/callback reads from its URL and the signed in user. */
export function readSignupCallback(search: URLSearchParams, user: CallbackUser | null | undefined): SignupCallbackContext {
  const fromUrl = decodeAttributionParam(search.get(ATTR_PARAM));
  const fromMetadata = fromUrl ? null : cleanAttributionHint(user?.user_metadata?.attribution);
  return { method: signupMethodOf(user), attribution: fromUrl ?? fromMetadata, profile: profileHintFrom(search) };
}
