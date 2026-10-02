/**
 * Paths that carry a bearer token or a link only key (docs/phases/PHASE_20.md
 * P20-13 and P20-57). Anyone holding such a URL can act on it, so error
 * reports (the Sentry scrubber, P20-13) and request logs (P20-57) replace the
 * token before anything leaves the server. One list, read by both.
 *
 * A prefix ending in "/" is followed by the token as the next path segment;
 * one without carries the token in its query string. Prefixes for routes
 * that have not merged yet are harmless. A test fails when a route folder
 * named [token] exists outside this list.
 */

export const TOKEN_PATH_PREFIXES = [
  // PHASE_19 P19-17: lasting chat file and preview links.
  "/api/mcp/files/",
  "/api/mcp/preview/",
  // PHASE_18 P18-06: the unsubscribe page and the one click route (?t=).
  "/email/unsubscribe",
  "/api/email/unsubscribe",
  // PHASE_20 P20-59: workspace invites.
  "/invite/",
  // PHASE_18 P18-04: the claim takedown link, and the share page the claim
  // link opens (/s/<slug>?claim=<token>); a share slug is itself a link
  // only key.
  "/api/claims/",
  "/s/",
  // PHASE_18 P18-05: pack feedback links.
  "/feedback/",
  "/api/feedback/",
  // PHASE_18 P18-12: a free preview's id is the anonymous visitor's only
  // key, including for the signed full size download.
  "/api/preview/",
] as const;

/** What a token segment becomes in a scrubbed path. */
export const TOKEN_PLACEHOLDER = "[token]";

/** The token prefix a path starts with, or null. */
export function tokenPathPrefix(pathname: string): string | null {
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

/**
 * A path or absolute URL with its token removed: the segment after a
 * matching prefix becomes [token], and the query string and fragment are
 * dropped, since they can hold the token too. Anything else comes back
 * unchanged (scrubbers drop other query strings by their own rule).
 */
export function redactTokenPath(input: string): string {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(input)?.[0] ?? "";
  const rest = input.slice(origin.length);
  const cut = rest.search(/[?#]/);
  const pathname = (cut === -1 ? rest : rest.slice(0, cut)) || "/";
  const prefix = tokenPathPrefix(pathname);
  if (!prefix) {
    return input;
  }
  if (!prefix.endsWith("/")) {
    return `${origin}${pathname}`;
  }
  const tail = pathname.slice(prefix.length);
  const slash = tail.indexOf("/");
  const after = slash === -1 ? "" : tail.slice(slash);
  return `${origin}${prefix}${tail.length > 0 ? TOKEN_PLACEHOLDER : ""}${after}`;
}
