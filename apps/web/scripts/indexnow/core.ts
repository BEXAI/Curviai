import { optionalEnv } from "../../src/lib/env";
import { isPublicCandidateUrl, type Inventory, type Observation } from "./inventory";
import {
  DAILY_URL_ATTEMPTS, INDEXNOW_ENDPOINT, indexNowKeyLocation, INDEXNOW_SITE,
  MAX_ATTEMPTS, MAX_BATCH, MAX_HISTORY, URL_DEBOUNCE_MS, parseState,
  type Entry, type IndexNowState, type Outcome,
} from "./model";

type Fetcher = typeof fetch;
type Save = (state: IndexNowState) => Promise<void>;

function validateInventory(inventory: Inventory): void {
  const urls = inventory.observations.map((entry) => entry.url);
  if (new Set(urls).size !== urls.length || urls.some((url) => !isPublicCandidateUrl(url))) {
    throw new Error("Inventory has duplicate or ineligible URLs.");
  }
  if (inventory.excluded.some((entry) => !isPublicCandidateUrl(entry.url))) {
    throw new Error("Inventory exclusion contains an unsafe URL.");
  }
}

function newEntry(observation: Observation, at: string, outcome: Outcome): Entry {
  return { ...observation, outcome, observedAt: at, attemptCount: 0, indexing: "unknown" };
}

export function initializeState(inventory: Inventory, now: Date): IndexNowState {
  validateInventory(inventory);
  if (!inventory.observations.length) throw new Error("Refusing an empty initial inventory.");
  if (inventory.observations.some((entry) => entry.kind !== "page")) throw new Error("A baseline can contain only current pages.");
  const at = now.toISOString();
  return parseState({
    version: 1, site: INDEXNOW_SITE, initializedAt: at, lastScanAt: at,
    entries: inventory.observations.map((entry) => newEntry(entry, at, "baseline")),
    budget: { day: at.slice(0, 10), urlAttempts: 0 }, history: [],
  });
}

/** A complete successful scan can queue changes. An outage never calls this. */
export function refreshState(previous: IndexNowState, inventory: Inventory, now: Date): IndexNowState {
  validateInventory(inventory);
  const state = parseState(structuredClone(previous));
  if (state.entries.some((entry) => !isPublicCandidateUrl(entry.url))) throw new Error("State contains ineligible URLs.");
  const at = now.toISOString();
  if (at < state.lastScanAt) throw new Error("Clock moved backwards; refusing a new scan.");
  const observations = new Map(inventory.observations.map((entry) => [entry.url, entry]));
  const excluded = new Set(inventory.excluded.map((entry) => entry.url));
  for (const entry of state.entries) {
    // A process may have died after the request left but before persisting its
    // response. IndexNow has no idempotency key; do not blindly resend it.
    if (entry.outcome === "attempting") {
      entry.outcome = "unknown";
      entry.reason = "interrupted_attempt";
    }
    const observation = observations.get(entry.url);
    if (!observation) {
      if (!excluded.has(entry.url)) throw new Error("Inventory did not account for a previous URL.");
      const newlyExcluded = entry.outcome !== "excluded";
      entry.outcome = "excluded";
      entry.reason = "not_currently_eligible";
      if (newlyExcluded) {
        entry.indexing = "unknown";
        delete entry.indexingObservedAt;
        delete entry.indexingSource;
      }
      continue;
    }
    if (entry.kind !== observation.kind || entry.fingerprint !== observation.fingerprint || entry.outcome === "excluded") {
      const lastAttemptAt = entry.lastAttemptAt;
      Object.keys(entry).forEach((key) => { delete (entry as unknown as Record<string, unknown>)[key]; });
      Object.assign(entry, newEntry(observation, at, "queued"), lastAttemptAt ? { lastAttemptAt } : {});
    } else {
      entry.observedAt = at;
      if (observation.lastmod) entry.lastmod = observation.lastmod;
      else delete entry.lastmod;
    }
    observations.delete(entry.url);
  }
  for (const observation of observations.values()) {
    if (observation.kind !== "page") throw new Error("A deleted URL must have been in the existing baseline.");
    state.entries.push(newEntry(observation, at, "queued"));
  }
  state.lastScanAt = at;
  return parseState(state);
}

/** Explicit operator recovery changes local state only; submit scans again. */
export function retryEntry(state: IndexNowState, url: string, acknowledgeUnknown: boolean): IndexNowState {
  const next = parseState(structuredClone(state));
  const entry = next.entries.find((candidate) => candidate.url === url);
  if (!entry || !["failed", "unknown", "key_pending"].some((status) => status === entry.outcome)) {
    throw new Error("Only failed, unknown or key_pending outcomes can be explicitly retried.");
  }
  if ((entry.outcome === "unknown" || entry.outcome === "key_pending") && !acknowledgeUnknown) {
    throw new Error("This notification may already have arrived or be processing. Review it and acknowledge duplicate risk before retrying.");
  }
  entry.outcome = "queued";
  entry.attemptCount = 0;
  delete entry.reason;
  delete entry.nextAttemptAt;
  delete entry.httpStatus;
  return next;
}

export function recordIndexing(state: IndexNowState, url: string, result: "indexed" | "not_indexed", observedAt: Date, now: Date): IndexNowState {
  const next = parseState(structuredClone(state));
  const entry = next.entries.find((candidate) => candidate.url === url);
  if (!entry) throw new Error("Indexing evidence must refer to a previously tracked public URL.");
  const at = observedAt.toISOString();
  if (at < entry.observedAt || observedAt.getTime() > now.getTime()) throw new Error("Bing observation must be current for this content and not in the future.");
  entry.indexing = result;
  entry.indexingObservedAt = at;
  entry.indexingSource = "operator_recorded_bing_inspection";
  return parseState(next);
}

export function configuredKey(): string {
  const key = optionalEnv("INDEXNOW_KEY");
  if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key)) {
    throw new Error("Set a valid approved INDEXNOW_KEY through secure configuration first.");
  }
  return key;
}

/** Always POST to one fixed official endpoint; no key in a query or log. */
export async function verifyOwnership(key: string, fetcher: Fetcher = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(indexNowKeyLocation(key), {
      redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Curvi-IndexNow/1.0", Accept: "text/plain" },
    });
  } catch { throw new Error("Ownership file could not be verified; no notification was sent."); }
  if (response.status !== 200 || response.redirected || (response.url && response.url !== indexNowKeyLocation(key))
    || (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "text/plain") {
    await response.body?.cancel();
    throw new Error("Ownership file must return HTTP 200 and plain text; no notification was sent.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ownership file is empty; no notification was sent.");
  let body = "";
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 256) throw new Error("invalid");
      body += decoder.decode(result.value, { stream: true });
    }
    body += decoder.decode();
    if (body.trim() !== key) throw new Error("invalid");
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Ownership file does not match the configured key; no notification was sent.");
  } finally { reader.releaseLock(); }
}

export function retryAfterMs(value: string | null, now: Date): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    return Number.isSafeInteger(seconds) && seconds <= 31_536_000 ? seconds * 1_000 : Infinity;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at - now.getTime() > 31_536_000_000 ? Infinity : Math.max(0, at - now.getTime()) : null;
}

export function dueEntries(state: IndexNowState, now: Date): Entry[] {
  if (state.blockedUntil && Date.parse(state.blockedUntil) > now.getTime()) return [];
  return state.entries.filter((entry) => {
    if (entry.outcome !== "queued" && entry.outcome !== "retryable") return false;
    if (entry.attemptCount >= MAX_ATTEMPTS) return false;
    const after = Math.max(
      entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : 0,
      entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) + URL_DEBOUNCE_MS : 0,
    );
    return after <= now.getTime();
  }).sort((left, right) => left.url.localeCompare(right.url));
}

function record(state: IndexNowState, batch: Entry[], at: string, outcome: Outcome, status?: number, reason?: string): void {
  state.history.push({ at, urls: batch.map((entry) => entry.url), outcome, ...(status ? { httpStatus: status } : {}), ...(reason ? { reason } : {}) });
  state.history = state.history.slice(-MAX_HISTORY);
}

export interface SubmitOptions {
  state: IndexNowState;
  key: string;
  save: Save;
  fetcher?: Fetcher;
  now?: () => Date;
  /** A further per-invocation cap; cannot exceed the fixed local daily cap. */
  maxUrls?: number;
}

/**
 * Bounded notifications. Retryable responses persist their next due time;
 * a later manual invocation resumes them instead of sleeping/looping here.
 */
export async function submitChanges(options: SubmitOptions): Promise<IndexNowState> {
  const state = parseState(structuredClone(options.state));
  if (state.entries.some((entry) => !isPublicCandidateUrl(entry.url))) throw new Error("State contains ineligible URLs.");
  if (!/^[A-Za-z0-9-]{8,128}$/.test(options.key)) throw new Error("IndexNow key format is invalid.");
  const maxUrls = options.maxUrls ?? MAX_BATCH;
  if (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > DAILY_URL_ATTEMPTS) throw new Error("Per-run URL cap must be between 1 and 500.");
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? fetch;
  let remaining = maxUrls;
  // A caller must persist the reviewed scan before this function. A stale
  // attempt is never auto-retried even if a caller bypasses refreshState.
  for (const entry of state.entries) if (entry.outcome === "attempting") { entry.outcome = "unknown"; entry.reason = "interrupted_attempt"; }
  if (dueEntries(state, now()).length === 0) return state;
  await verifyOwnership(options.key, fetcher);
  while (remaining > 0) {
    const clock = now();
    const at = clock.toISOString();
    const day = at.slice(0, 10);
    if (day < state.budget.day) throw new Error("Clock moved backwards; refusing quota reset.");
    if (day > state.budget.day) state.budget = { day, urlAttempts: 0 };
    const allowance = Math.min(MAX_BATCH, remaining, DAILY_URL_ATTEMPTS - state.budget.urlAttempts);
    if (allowance <= 0) break;
    const batch = dueEntries(state, clock).slice(0, allowance);
    if (!batch.length) break;
    for (const entry of batch) {
      entry.outcome = "attempting";
      entry.attemptCount += 1;
      entry.lastAttemptAt = at;
      delete entry.nextAttemptAt;
      delete entry.httpStatus;
      delete entry.reason;
    }
    state.budget.urlAttempts += batch.length;
    record(state, batch, at, "attempting");
    // Write-ahead reservation prevents a crash from silently duplicating a
    // submission or resetting the local quota. No POST until this succeeds.
    await options.save(parseState(state));
    let status: number | undefined;
    let retryAfter: number | null = null;
    try {
      const response = await fetcher(INDEXNOW_ENDPOINT, {
        method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Curvi-IndexNow/1.0" },
        body: JSON.stringify({ host: "curvi.ai", key: options.key, urlList: batch.map((entry) => entry.url) }),
      });
      status = response.status;
      retryAfter = retryAfterMs(response.headers.get("retry-after"), now());
      // Response bodies can echo keys/URLs or be unbounded; never log/store them.
      await response.body?.cancel().catch(() => undefined);
    } catch { /* A request may have arrived despite a timeout or network error. */ }
    const finished = now();
    const retryable = status === 429 || (status !== undefined && status >= 500);
    const outcome: Outcome = status === 200 ? "accepted" : status === 202 ? "key_pending" : status === undefined ? "unknown" : retryable ? "retryable" : "failed";
    const reason = status === undefined ? "delivery_unknown" : outcome === "failed" ? "http_refusal" : undefined;
    for (const entry of batch) {
      entry.outcome = retryable && entry.attemptCount >= MAX_ATTEMPTS ? "failed" : outcome;
      if (status !== undefined) entry.httpStatus = status;
      if (reason) entry.reason = reason;
      if (retryable) {
        entry.reason = entry.outcome === "failed" ? "attempt_limit" : "retry_later";
        const backoff = Math.max(URL_DEBOUNCE_MS * 2 ** (entry.attemptCount - 1), retryAfter ?? 0);
        // An unsupported extreme server delay remains blocked for review;
        // do not clamp it to an earlier retry and violate Retry-After.
        entry.nextAttemptAt = Number.isFinite(backoff) ? new Date(finished.getTime() + backoff).toISOString() : "9999-12-31T23:59:59.000Z";
      }
    }
    if (retryable) {
      // Stop the whole run, not just this batch; preserve a host-wide pause.
      state.blockedUntil = batch[0]!.nextAttemptAt;
    }
    record(state, batch, finished.toISOString(), batch[0]!.outcome, status, batch[0]!.reason);
    await options.save(parseState(state));
    remaining -= batch.length;
    if (outcome !== "accepted" && outcome !== "key_pending") break;
  }
  return state;
}

export function summarize(state: IndexNowState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const indexing: Record<string, number> = {};
  for (const entry of state.entries) counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  for (const entry of state.entries) indexing[entry.indexing] = (indexing[entry.indexing] ?? 0) + 1;
  return { site: state.site, initializedAt: state.initializedAt, lastScanAt: state.lastScanAt, counts,
    budget: state.budget, blockedUntil: state.blockedUntil ?? null, indexing,
    note: "Accepted and key_pending describe notification receipt. Check Bing Webmaster Tools for indexing evidence." };
}
