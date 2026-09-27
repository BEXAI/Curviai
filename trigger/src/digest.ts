/**
 * Weekly metrics digest: pure composition of the founder email plus a
 * Resend REST sender using plain fetch (CURVI_BUILD_PLAN.md section 8, the
 * Trigger.dev cron row). Envless behavior: without RESEND_API_KEY and a
 * recipient the sender returns a clear setup notice and sends nothing.
 */

export interface MonthlyMetrics {
  /** Month the numbers describe, e.g. "2026-09". */
  month: string;
  mrrUsd: number;
  /** Monthly churn as a share, 0 to 1. */
  churnRate: number;
  cogsUsd: number;
  /** Gross margin as a share, 0 to 1. */
  grossMargin: number;
  /** True when the numbers come from the in memory demo reader. */
  demo?: boolean;
}

export interface MetricsReader {
  read(): Promise<MonthlyMetrics>;
}

/** In memory demo metrics so the cron runs with zero env configured. */
export class DemoMetricsReader implements MetricsReader {
  constructor(private readonly month: string) {}

  async read(): Promise<MonthlyMetrics> {
    return {
      month: this.month,
      mrrUsd: 0,
      churnRate: 0,
      cogsUsd: 0,
      grossMargin: 0,
      demo: true,
    };
  }
}

export interface DigestEmail {
  subject: string;
  text: string;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function composeDigest(metrics: MonthlyMetrics): DigestEmail {
  const lines = [
    `Curvi metrics for ${metrics.month}.`,
    "",
    `MRR: ${usd.format(metrics.mrrUsd)}`,
    `Churn: ${pct(metrics.churnRate)}`,
    `COGS: ${usd.format(metrics.cogsUsd)}`,
    `Gross margin: ${pct(metrics.grossMargin)}`,
  ];
  if (metrics.demo) {
    lines.push(
      "",
      "These are demo numbers. Connect the database and billing so the digest reads real figures.",
    );
  }
  return {
    subject: `Curvi weekly metrics for ${metrics.month}`,
    text: lines.join("\n"),
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SendDigestOptions {
  apiKey?: string;
  from?: string;
  to?: string;
  fetchImpl?: FetchLike;
}

export interface DigestSendResult {
  sent: boolean;
  id?: string;
  notice?: string;
}

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
export const DEFAULT_DIGEST_FROM = "Curvi Reports <reports@curvi.ai>";

export async function sendDigestEmail(
  email: DigestEmail,
  opts: SendDigestOptions,
): Promise<DigestSendResult> {
  if (!opts.apiKey) {
    return {
      sent: false,
      notice: "Set RESEND_API_KEY to send the weekly metrics digest. The digest was composed but not sent.",
    };
  }
  if (!opts.to) {
    return {
      sent: false,
      notice:
        "Set METRICS_DIGEST_TO to the founder email address to send the weekly metrics digest. The digest was composed but not sent.",
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: opts.from ?? DEFAULT_DIGEST_FROM,
      to: [opts.to],
      subject: email.subject,
      text: email.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      sent: false,
      notice: `Resend returned status ${res.status}. ${body}`.trim(),
    };
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, id: data.id };
}
