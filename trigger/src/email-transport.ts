/** Shared fetch contract for provider probes and operational email. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
