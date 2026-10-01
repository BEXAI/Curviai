/**
 * Who may open the operator pages under /app/ops: signed in users whose
 * confirmed email is listed in OPS_EMAILS, a server only, comma separated
 * list compared without regard to case. OPS_EMAIL (singular) is read the
 * same way when OPS_EMAILS is unset or empty, since that name is easy to
 * type by mistake; OPS_EMAILS wins when both are set. With neither set
 * nobody is an operator. Pages call notFound() for everyone else, so the
 * pages do not show up for anyone who is not on the list.
 */

import { optionalEnv } from "@/lib/env";

/** The operator emails from OPS_EMAILS (or OPS_EMAIL), trimmed and lower case. */
export function opsEmails(): string[] {
  return (optionalEnv("OPS_EMAILS") ?? optionalEnv("OPS_EMAIL") ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export interface OpsCandidate {
  email?: string | null;
  /** Supabase sets this once the address is confirmed. */
  email_confirmed_at?: string | null;
}

/** True when the signed in user is an operator. */
export function isOperator(user: OpsCandidate | null | undefined): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email || !user?.email_confirmed_at) {
    return false;
  }
  return opsEmails().includes(email);
}
