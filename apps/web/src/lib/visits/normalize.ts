/**
 * What a page view stores, cleaned before it reaches the database
 * (migration 0027): a path with no query string, fragment or ids in it, a
 * referrer reduced to its host, short UTM values and a device class. Pure
 * functions, safe anywhere.
 */

import type { VisitDevice } from "@curvi/db/schema";

export const MAX_PATH_LENGTH = 300;
export const MAX_HOST_LENGTH = 255;
export const MAX_UTM_LENGTH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_NUMBER = /^\d{6,}$/;
const LONG_HEX = /^(?=.*\d)[0-9a-f]{16,}$/i;
// Control characters, which no path, host or campaign name needs.
const CONTROL = /[\u0000-\u001f\u007f]/g;

function isIdSegment(segment: string): boolean {
  return UUID.test(segment) || LONG_NUMBER.test(segment) || LONG_HEX.test(segment);
}

/**
 * The path as stored: no query string or fragment, no repeated or trailing
 * slash, every id (a UUID, a long number, a long hex string, a share page
 * slug) replaced with :id, and at most MAX_PATH_LENGTH characters. Null for
 * anything that is not a path on this site.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const path = raw.split(/[?#]/, 1)[0].replace(CONTROL, "").trim();
  if (!path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const cleaned = segments.map((segment, index) => {
    // /s/{slug} is a share page: its slug is a link someone was given.
    if (index === 1 && segments[0] === "s") {
      return ":id";
    }
    return isIdSegment(segment) ? ":id" : segment;
  });
  const normalized = `/${cleaned.join("/")}`;
  return normalized.slice(0, MAX_PATH_LENGTH);
}

/** The host without a leading www., lower case. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * The host of the page that sent the visitor here, without www., or null
 * when there is none, it is not a web address, or it is this site itself
 * (ownHosts: the configured site host and the host the request came to).
 */
export function referrerHost(raw: unknown, ownHosts: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = bareHost(url.hostname);
  if (!host) {
    return null;
  }
  const own = new Set(ownHosts.filter(Boolean).map((h) => bareHost(h.replace(/:\d+$/, ""))));
  if (own.has(host)) {
    return null;
  }
  return host.slice(0, MAX_HOST_LENGTH);
}

/** A UTM value as stored: trimmed, lower case, short, or null when empty. */
export function cleanUtm(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.replace(CONTROL, "").trim().toLowerCase().slice(0, MAX_UTM_LENGTH).trim();
  return value.length > 0 ? value : null;
}

const TABLET = /ipad|tablet|playbook|silk|kindle|(android(?!.*mobile))/i;
const MOBILE = /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|iemobile/i;

/**
 * Mobile, tablet or desktop from the user agent, plus the Sec-CH-UA-Mobile
 * client hint Chromium browsers send by default. An iPad on iPadOS 13 or
 * later reports a Mac user agent, so it counts as desktop.
 */
export function deviceClass(userAgent: string, mobileHint?: string | null): VisitDevice {
  if (TABLET.test(userAgent)) {
    return "tablet";
  }
  if (mobileHint === "?1" || MOBILE.test(userAgent)) {
    return "mobile";
  }
  return "desktop";
}
