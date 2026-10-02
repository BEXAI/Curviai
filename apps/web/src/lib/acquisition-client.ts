/**
 * The browser side of the acquisition gate (docs/phases/PHASE_18.md P18-03):
 * one GET /api/status per page and per minute at most, shared by every call
 * to action on the page. Client safe: no server imports. Any failure reads
 * as open, so a broken status route never hides the signup links.
 */

import type { LeadSource } from "@/lib/lead-sources";

export type ClientAcquisitionState = "open" | "waitlist";

/** Where the waitlist dialog stores emails (lib/lead-sources). */
export const WAITLIST_LEAD_SOURCE: LeadSource = "packs-paused";

export const STATUS_PATH = "/api/status";

/** A page reuses its answer for this long before asking again (client
 * side navigations keep the module alive). The server caches its own. */
export const CLIENT_STATUS_TTL_MS = 60_000;

/** Reads the route's body; anything unexpected is open. */
export function parseStatusBody(body: unknown): ClientAcquisitionState {
  return (body as { acquisition?: unknown } | null)?.acquisition === "waitlist" ? "waitlist" : "open";
}

let cached: { at: number; state: Promise<ClientAcquisitionState> } | null = null;

/** The gate as the browser sees it. Never rejects. */
export function fetchAcquisitionState(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ClientAcquisitionState> {
  if (cached && now() - cached.at < CLIENT_STATUS_TTL_MS) {
    return cached.state;
  }
  const state = fetchImpl(STATUS_PATH, { credentials: "omit", headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then(parseStatusBody)
    .catch((): ClientAcquisitionState => "open");
  cached = { at: now(), state };
  return state;
}

/** Forgets the cached answer (tests). */
export function resetClientAcquisitionForTests(): void {
  cached = null;
}
