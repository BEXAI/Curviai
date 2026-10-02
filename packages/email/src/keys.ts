/**
 * The key an email address is logged and suppressed under
 * (docs/phases/PHASE_18.md P18-06): the sha256 hex of the address
 * normalized by the rules of normalized_email_key in migration 0012, so
 * email_sends and email_suppressions never hold an address, and an
 * unsubscribe covers every spelling of one inbox (case, a +tag, Gmail dots).
 *
 * The rules, as in SQL: trim spaces and lower case; the domain is what
 * follows the last @; the local part drops everything from the first +;
 * for gmail.com and googlemail.com the dots in the local part go and the
 * domain becomes gmail.com. No @, no domain or an empty local part gives
 * null. keys.test.ts checks this against the SQL function.
 */

import { createHash } from "node:crypto";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** The normalized address the key is computed over, or null. */
export function normalizedEmailAddress(email: string | null | undefined): string | null {
  // btrim() in SQL trims spaces only, not other whitespace.
  const value = email ?? "";
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 32) start++;
  while (end > start && value.charCodeAt(end - 1) === 32) end--;
  const addr = value.slice(start, end).toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0 || at === addr.length - 1) {
    return null;
  }
  let domain = addr.slice(at + 1);
  let local = addr.slice(0, at).split("+")[0];
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  if (local === "") {
    return null;
  }
  return `${local}@${domain}`;
}

/** sha256 hex of the normalized address, or null for something that is not one. */
export function normalizedEmailKey(email: string | null | undefined): string | null {
  const normalized = normalizedEmailAddress(email);
  return normalized === null ? null : createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** True for a 64 character lower case sha256 hex key. */
export function isRecipientKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
