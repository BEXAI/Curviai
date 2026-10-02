/**
 * Lifecycle email templates and their rendering (docs/phases/PHASE_18.md
 * P18-06): a typed TS module per template returns a subject and plain
 * paragraphs; renderEmail adds the sign off and the footer for its kind and
 * builds the plain text body and a minimal HTML body from the same lines.
 *
 * Every link a template makes through ctx.link carries
 * utm_source=curvi_email, utm_medium=email and utm_campaign=<template>, so
 * the signup attribution (P18-01) credits a returning signup to the email.
 * No open tracking pixel, no click redirect.
 */

import {
  ACCOUNT_REASON,
  DEFAULT_SIGN_OFF,
  LEAD_MARKETING_REASON,
  LEAD_REASON,
  MARKETING_NOTICE,
  MARKETING_REASON,
  UNSUBSCRIBE_LINE,
  postalLine,
} from "./copy";

export type EmailKind = "transactional" | "marketing";
/** Who a template is for: a signed up account or a lead from a free tool. */
export type EmailAudience = "account" | "lead";

export interface RenderContext {
  siteUrl: string;
  /** The template key, used as utm_campaign. */
  template: string;
  founderName: string | null;
  /** An absolute link on the site with the email's UTM tags (and any extra
   * query values), for example ctx.link("/app/new"). */
  link(path: string, params?: Readonly<Record<string, string>>): string;
}

export interface EmailContent {
  subject: string;
  /** Plain text paragraphs; a link is written out in full and may end one. */
  paragraphs: string[];
}

export interface EmailTemplate<D = unknown> {
  /** Stored as email_sends.template and used as utm_campaign. */
  key: string;
  kind: EmailKind;
  audience: EmailAudience;
  render(data: D, ctx: RenderContext): EmailContent;
}

/** The unsubscribe links of one marketing email. */
export interface UnsubscribeLinks {
  /** The page with the one confirm button, linked in the footer. */
  pageUrl: string;
  /** The RFC 8058 one click POST target, in the List-Unsubscribe header. */
  oneClickUrl: string;
  /** Optional mailto address for clients that only send mail. */
  mailto: string | null;
}

export interface RenderOptions {
  siteUrl: string;
  founderName: string | null;
  /** Marketing only, both required. */
  unsubscribe?: UnsubscribeLinks;
  postalAddress?: string | null;
}

export interface RenderedEmail {
  template: string;
  kind: EmailKind;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export const UTM_SOURCE = "curvi_email";
export const UTM_MEDIUM = "email";

/** An absolute site link with the email UTM tags for one template. */
export function emailLink(
  siteUrl: string,
  template: string,
  path: string,
  params: Readonly<Record<string, string>> = {},
): string {
  // Scan the suffix once; an unanchored slash regex can retry a long
  // internal slash run from every starting position when it ends in text.
  let baseEnd = siteUrl.length;
  while (baseEnd > 0 && siteUrl[baseEnd - 1] === "/") baseEnd--;
  const url = new URL(path, `${siteUrl.slice(0, baseEnd)}/`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("utm_source", UTM_SOURCE);
  url.searchParams.set("utm_medium", UTM_MEDIUM);
  url.searchParams.set("utm_campaign", template);
  return url.toString();
}

export function renderContext(template: string, options: Pick<RenderOptions, "siteUrl" | "founderName">): RenderContext {
  return {
    siteUrl: options.siteUrl,
    template,
    founderName: options.founderName,
    link: (path, params) => emailLink(options.siteUrl, template, path, params),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+)/g;

/** One paragraph as HTML: text escaped, every written out link made clickable. */
export function paragraphHtml(paragraph: string): string {
  return paragraph
    .split(URL_PATTERN)
    .map((part, i) => {
      if (i % 2 === 0) {
        return escapeHtml(part).replace(/\n/g, "<br>");
      }
      // A sentence may end right after a link; the full stop is not part of it.
      // Read only the suffix so punctuation inside a link cannot cause
      // repeated scans of the same run.
      let urlEnd = part.length;
      while (urlEnd > 0 && ".,;:)".includes(part[urlEnd - 1])) urlEnd--;
      const trailing = part.slice(urlEnd);
      const url = part.slice(0, urlEnd);
      return `<a href="${escapeHtml(url)}" style="color:#1d4ed8">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    })
    .join("");
}

/** The footer lines for a kind and audience. Marketing needs the links and the address. */
export function footerLines(
  kind: EmailKind,
  audience: EmailAudience,
  unsubscribe: UnsubscribeLinks | undefined,
  postalAddress: string | null | undefined,
): string[] {
  if (kind === "transactional") {
    return [audience === "account" ? ACCOUNT_REASON : LEAD_REASON];
  }
  if (!unsubscribe || !postalAddress) {
    throw new Error("A marketing email needs its unsubscribe links and the postal address.");
  }
  const reason = audience === "account" ? MARKETING_REASON : LEAD_MARKETING_REASON;
  return [`${MARKETING_NOTICE} ${reason}`, `${UNSUBSCRIBE_LINE} ${unsubscribe.pageUrl}`, postalLine(postalAddress)];
}

/** The subject, both bodies and the headers of one email. Pure. */
export function renderEmail<D>(template: EmailTemplate<D>, data: D, options: RenderOptions): RenderedEmail {
  const content = template.render(data, renderContext(template.key, options));
  const signOff = options.founderName ?? DEFAULT_SIGN_OFF;
  const footer = footerLines(template.kind, template.audience, options.unsubscribe, options.postalAddress);
  const body = [...content.paragraphs, signOff];
  const text = `${body.join("\n\n")}\n\n${footer.join("\n")}\n`;
  const html = [
    "<!doctype html>",
    '<html><body style="margin:0;padding:24px;background:#ffffff;color:#111827;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">',
    '<div style="max-width:560px">',
    ...body.map((paragraph) => `<p style="margin:0 0 16px">${paragraphHtml(paragraph)}</p>`),
    `<p style="margin:24px 0 0;color:#6b7280;font-size:12px">${footer.map(paragraphHtml).join("<br>")}</p>`,
    "</div>",
    "</body></html>",
  ].join("\n");
  const headers: Record<string, string> = {};
  if (template.kind === "marketing" && options.unsubscribe) {
    const targets = [`<${options.unsubscribe.oneClickUrl}>`];
    if (options.unsubscribe.mailto) {
      targets.push(`<mailto:${options.unsubscribe.mailto}?subject=unsubscribe>`);
    }
    headers["List-Unsubscribe"] = targets.join(", ");
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return { template: template.key, kind: template.kind, subject: content.subject, text, html, headers };
}
