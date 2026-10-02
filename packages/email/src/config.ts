/**
 * What lifecycle email needs from the environment (docs/phases/PHASE_18.md
 * P18-06), read at call time so nothing breaks while it is unset:
 *
 * - RESEND_API_KEY, LIFECYCLE_EMAIL_FROM (an address on the Resend verified
 *   updates.curvi.ai subdomain) and LIFECYCLE_REPLY_TO (the founder's inbox):
 *   without any of them no customer email is sent.
 * - CURVI_LINK_SECRET signs the unsubscribe links: without it no marketing
 *   email is sent (it would have no working unsubscribe).
 * - CURVI_POSTAL_ADDRESS (founder decision 4, CAN-SPAM): without it, or
 *   while it still holds a placeholder, no marketing email is sent;
 *   transactional email does not wait for it.
 * - NEXT_PUBLIC_SITE_URL builds every link; marketing email also needs it
 *   on https, because the one click unsubscribe header must be an HTTPS URI
 *   (RFC 8058).
 * - LIFECYCLE_FOUNDER_NAME (optional) signs the emails and names the founder
 *   in the welcome email.
 *
 * Values are never logged or put in an error: gaps are reported by name.
 */

export type ReadEnv = (name: string) => string | undefined;

export interface EmailConfig {
  apiKey: string | null;
  from: string | null;
  replyTo: string | null;
  linkSecret: string | null;
  postalAddress: string | null;
  siteUrl: string;
  founderName: string | null;
}

export const EMAIL_ENV = {
  apiKey: "RESEND_API_KEY",
  from: "LIFECYCLE_EMAIL_FROM",
  replyTo: "LIFECYCLE_REPLY_TO",
  linkSecret: "CURVI_LINK_SECRET",
  postalAddress: "CURVI_POSTAL_ADDRESS",
  siteUrl: "NEXT_PUBLIC_SITE_URL",
  founderName: "LIFECYCLE_FOUNDER_NAME",
} as const;

const DEFAULT_SITE_URL = "http://localhost:3000";

function readEnvDefault(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The postal address as it may print in a footer, or null while it is unset
 * or still a placeholder ("[postal address]", "TODO", "PO Box TBD" and the
 * like). Whitespace and line breaks collapse to single spaces.
 */
export function usablePostalAddress(value: string | null | undefined): string | null {
  const address = (value ?? "").replace(/\s+/g, " ").trim();
  if (address.length < 10 || address.length > 200) {
    return null;
  }
  if (/[[\]{}<>]/.test(address) || /\b(todo|tbd|placeholder|example|your address|postal address)\b/i.test(address)) {
    return null;
  }
  return address;
}

export function emailConfigFromEnv(readEnv: ReadEnv = readEnvDefault): EmailConfig {
  return {
    apiKey: clean(readEnv(EMAIL_ENV.apiKey)),
    from: clean(readEnv(EMAIL_ENV.from)),
    replyTo: clean(readEnv(EMAIL_ENV.replyTo)),
    linkSecret: clean(readEnv(EMAIL_ENV.linkSecret)),
    postalAddress: usablePostalAddress(readEnv(EMAIL_ENV.postalAddress)),
    siteUrl: (clean(readEnv(EMAIL_ENV.siteUrl)) ?? DEFAULT_SITE_URL).replace(/\/+$/, ""),
    founderName: clean(readEnv(EMAIL_ENV.founderName))?.slice(0, 60) ?? null,
  };
}

/** The variables any lifecycle email still needs, by name. */
export function transactionalGaps(config: EmailConfig): string[] {
  const gaps: string[] = [];
  if (!config.apiKey) gaps.push(EMAIL_ENV.apiKey);
  if (!config.from) gaps.push(EMAIL_ENV.from);
  if (!config.replyTo) gaps.push(EMAIL_ENV.replyTo);
  return gaps;
}

/** The variables a marketing email still needs, by name (the transactional ones included). */
export function marketingGaps(config: EmailConfig): string[] {
  const gaps = transactionalGaps(config);
  if (!config.linkSecret) gaps.push(EMAIL_ENV.linkSecret);
  if (!config.postalAddress) gaps.push(EMAIL_ENV.postalAddress);
  if (!config.siteUrl.startsWith("https://")) gaps.push(`${EMAIL_ENV.siteUrl} (https)`);
  return gaps;
}

/** The bare address inside "Name <address>", or the value itself when it is one. */
export function bareAddress(value: string | null): string | null {
  if (!value) return null;
  const inside = /<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value.trim();
  return /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(inside) ? inside : null;
}
