/**
 * Content Security Policy violation reports (the report only policy in
 * next.config.ts). Browsers post them in two shapes, checked against MDN on
 * 2026-09-28 (docs/verification.md):
 * - report-uri: Content-Type application/csp-report, one object under
 *   "csp-report" with kebab case fields (document-uri, blocked-uri,
 *   violated-directive, effective-directive, ...).
 * - report-to (Reporting API): Content-Type application/reports+json, an
 *   array of reports; CSP ones have type "csp-violation" and a camel case
 *   body (documentURL, blockedURL, effectiveDirective, disposition, ...).
 * Both normalize to one small record for the log. Query strings and
 * fragments are cut from every URL and script samples are dropped, since
 * either can carry a user's data.
 */

import { redactTokenPath } from "@/lib/token-paths";

export interface CspViolation {
  documentUrl: string | null;
  blockedUrl: string | null;
  directive: string | null;
  disposition: string | null;
  sourceFile: string | null;
  line: number | null;
  column: number | null;
  statusCode: number | null;
}

/** Largest report body the endpoint reads. */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;
/** Reports taken from one request; a batch beyond it is cut. */
export const CSP_REPORTS_PER_REQUEST = 20;

const ACCEPTED_TYPES = ["application/csp-report", "application/reports+json", "application/json"];

export function isCspReportContentType(contentType: string | null): boolean {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ACCEPTED_TYPES.includes(base);
}

/** A URL without its query and fragment, a scheme alone for data: and blob:
 * URLs, or a keyword such as "inline" as is. */
export function redactUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    // data:, blob: and similar carry their content in the path: keep the scheme only.
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return url.protocol;
    }
    return redactTokenPath(`${url.origin}${url.pathname}`).slice(0, 300);
  } catch {
    return value.split(/[?#]/)[0].slice(0, 100);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 100) : null;
}

function int(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function fromLegacy(report: Record<string, unknown>): CspViolation {
  return {
    documentUrl: redactUrl(report["document-uri"]),
    blockedUrl: redactUrl(report["blocked-uri"]),
    directive: text(report["effective-directive"]) ?? text(report["violated-directive"]),
    disposition: text(report.disposition),
    sourceFile: redactUrl(report["source-file"]),
    line: int(report["line-number"]),
    column: int(report["column-number"]),
    statusCode: int(report["status-code"]),
  };
}

function fromReportingApi(body: Record<string, unknown>): CspViolation {
  return {
    documentUrl: redactUrl(body.documentURL),
    blockedUrl: redactUrl(body.blockedURL),
    directive: text(body.effectiveDirective),
    disposition: text(body.disposition),
    sourceFile: redactUrl(body.sourceFile),
    line: int(body.lineNumber),
    column: int(body.columnNumber),
    statusCode: int(body.statusCode),
  };
}

/** Every CSP violation in a report body; empty for anything else. */
export function parseCspReports(raw: string): CspViolation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const legacy = asRecord(asRecord(parsed)?.["csp-report"]);
  if (legacy) {
    return [fromLegacy(legacy)];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: CspViolation[] = [];
  for (const entry of parsed.slice(0, CSP_REPORTS_PER_REQUEST)) {
    const report = asRecord(entry);
    const body = asRecord(report?.body);
    if (report?.type === "csp-violation" && body) {
      out.push(fromReportingApi(body));
    }
  }
  return out;
}

/**
 * Caps how many violations one instance logs per window, so a page that
 * violates on every load, or someone posting junk, cannot flood the log.
 * Per process on purpose: this is log hygiene, not access control.
 */
export class ReportLogBudget {
  private windowStart = 0;
  private used = 0;
  private dropped = 0;

  constructor(
    private readonly limit = 100,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many of `count` may be logged now, plus how many were dropped in
   * the window that just closed (reported once). */
  take(count: number): { allowed: number; droppedBefore: number } {
    const t = this.now();
    let droppedBefore = 0;
    if (t - this.windowStart >= this.windowMs) {
      droppedBefore = this.dropped;
      this.windowStart = t;
      this.used = 0;
      this.dropped = 0;
    }
    const allowed = Math.max(0, Math.min(count, this.limit - this.used));
    this.used += allowed;
    this.dropped += count - allowed;
    return { allowed, droppedBefore };
  }
}
