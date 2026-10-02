/**
 * Scrubs an error report before it leaves the server (docs/phases/PHASE_20.md
 * P20-13). The SDK's own collection is already turned down
 * (DATA_COLLECTION in lib/sentry/options.ts); this removes what can still
 * reach an event, whatever the SDK version collects:
 * - request headers: only a short allowlist survives, so authorization,
 *   cookies, x-cron-secret, the Stripe signature and every other credential
 *   header are dropped;
 * - request bodies, cookies, query strings and the server env block;
 * - link only tokens in paths (TOKEN_PATH_PREFIXES in lib/token-paths.ts,
 *   the same list the request logger reads): the token segment becomes
 *   [token], in the request URL and in any text;
 * - query strings in any URL or path inside text, since they can carry a
 *   token too (?t=, ?claim=, ?code=, ?token_hash=);
 * - secrets in text: bearer tokens, Stripe and model provider keys, JWTs,
 *   credentials inside connection strings, and the value of every secret
 *   looking server variable (SECRET, KEY, TOKEN, PASSWORD, DATABASE_URL);
 * - the user block, down to an id.
 * Stack frames are left alone: they hold file names, functions and source
 * lines, and local variable collection is off (DATA_COLLECTION).
 *
 * Pure: the env is passed in, so tests drive it without process.env.
 */

import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { TOKEN_PATH_PREFIXES, TOKEN_PLACEHOLDER, redactTokenPath } from "@/lib/token-paths";

/** What a removed secret becomes in text. */
export const REDACTED = "[redacted]";

/** The only request headers an event keeps. Everything else, credentials
 * included, is dropped. Referer is kept but scrubbed like any URL. */
export const KEPT_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "referer",
  "rndr-id",
  "user-agent",
  "x-request-id",
]);

/** Server variables whose values are secrets by name. NEXT_PUBLIC_ values
 * ship to every browser, so they are not treated as secrets. */
const SECRET_ENV_NAME = /(SECRET|_KEY$|_KEY_|TOKEN|PASSWORD|DATABASE_URL|_DSN$|PRIVATE)/;
/** Shorter values are too likely to appear by chance to be replaced. */
const MIN_SECRET_LENGTH = 12;

/** Keys of an event that are never walked: frames, SDK and module lists. */
const SKIPPED_KEYS = new Set(["stacktrace", "frames", "debug_meta", "sdk", "modules", "fingerprint"]);
const MAX_DEPTH = 8;

export interface Scrubber {
  scrubText(text: string): string;
  scrubEvent(event: ErrorEvent): ErrorEvent;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The secret values of the env, longest first, so a value that contains
 * another is replaced whole. */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH || name.startsWith("NEXT_PUBLIC_")) continue;
    if (SECRET_ENV_NAME.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** An absolute URL without its query string and fragment, its token
 * segment replaced. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  return redactTokenPath(bare);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Credentials inside a connection string or URL: scheme://user:pass@host.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Stripe secret, restricted and webhook keys.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, REDACTED],
  // OpenAI and Anthropic keys (sk-..., sk-ant-..., sk-proj-...).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Resend keys.
  [/\bre_[A-Za-z0-9_]{16,}/g, REDACTED],
  // JWTs, such as Supabase access tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Email addresses in third party error text (Stripe, Resend, Postgres
  // name the customer's address; security review 3).
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, "[email]"],
];

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>`]+/gi;
/** A path starting a token, after a boundary that is not part of a longer
 * path (so /docs/s/x is not read as /s/x). A segment that starts with "["
 * is a route pattern ([token], [slug]) or a token already replaced, and is
 * left alone. */
const TOKEN_PATHS: Array<{ pattern: RegExp; replacement: string }> = TOKEN_PATH_PREFIXES.map((prefix) =>
  prefix.endsWith("/")
    ? {
        pattern: new RegExp(`(^|[^\\w/.:-])(${escapeRegExp(prefix)})(?!\\[)[^\\s"'?#/)\\]>]+`, "g"),
        replacement: `$1$2${TOKEN_PLACEHOLDER}`,
      }
    : {
        pattern: new RegExp(`(^|[^\\w/.:-])(${escapeRegExp(prefix)})\\?[^\\s"'#)\\]>]*`, "g"),
        replacement: "$1$2",
      },
);
/** A relative path followed by a query string: the query goes. */
const PATH_QUERY = /(^|[\s"'(=:,[])(\/[A-Za-z0-9_\-./[\]~%]*)\?[^\s"'<>#)\]]*/g;

export function createScrubber(env: Record<string, string | undefined> = {}): Scrubber {
  const secrets = secretEnvValues(env);

  function scrubText(text: string): string {
    if (!text) return text;
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    out = out.replace(ABSOLUTE_URL, (url) => scrubUrl(url));
    for (const { pattern, replacement } of TOKEN_PATHS) {
      out = out.replace(pattern, replacement);
    }
    return out.replace(PATH_QUERY, "$1$2");
  }

  function scrubValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") return scrubText(value);
    if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SKIPPED_KEYS.has(key) ? item : scrubValue(item, depth + 1);
    }
    return out;
  }

  function scrubRequest(request: NonNullable<ErrorEvent["request"]>): NonNullable<ErrorEvent["request"]> {
    const out: NonNullable<ErrorEvent["request"]> = {};
    if (request.method) out.method = request.method;
    if (request.url) out.url = scrubText(scrubUrl(request.url));
    if (request.headers) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (KEPT_REQUEST_HEADERS.has(name.toLowerCase()) && typeof value === "string") {
          headers[name] = scrubText(name.toLowerCase() === "referer" ? scrubUrl(value) : value);
        }
      }
      out.headers = headers;
    }
    // data (the body), cookies, query_string and env are dropped.
    return out;
  }

  function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
    return scrubValue(crumb, 0) as Breadcrumb;
  }

  function scrubEvent(event: ErrorEvent): ErrorEvent {
    const out: ErrorEvent = { ...event };
    if (out.request) out.request = scrubRequest(out.request);
    if (out.user) out.user = out.user.id !== undefined ? { id: out.user.id } : {};
    if (out.message) out.message = scrubText(out.message);
    if (out.transaction) out.transaction = scrubText(out.transaction);
    if (out.logentry) out.logentry = scrubValue(out.logentry, 0) as ErrorEvent["logentry"];
    if (out.exception?.values) {
      out.exception = {
        ...out.exception,
        values: out.exception.values.map((value) => ({ ...value, ...(value.value ? { value: scrubText(value.value) } : {}) })),
      };
    }
    if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);
    if (out.extra) out.extra = scrubValue(out.extra, 0) as ErrorEvent["extra"];
    if (out.contexts) out.contexts = scrubValue(out.contexts, 0) as ErrorEvent["contexts"];
    if (out.tags) out.tags = scrubValue(out.tags, 0) as ErrorEvent["tags"];
    return out;
  }

  return { scrubText, scrubEvent };
}
