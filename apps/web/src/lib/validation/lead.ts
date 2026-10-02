/**
 * Request validation for POST /api/leads. The sources and the honeypot
 * field name live in lib/lead-sources, which the email gate shares.
 */

import { z } from "zod";
import { LEAD_HONEYPOT_FIELD, LEAD_SOURCES, type LeadSource } from "@/lib/lead-sources";

export { LEAD_HONEYPOT_FIELD, LEAD_SOURCES, type LeadSource };

export const EMAIL_MAX_LENGTH = 254;

export const leadRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).pipe(z.email()),
  source: z.enum(LEAD_SOURCES),
  /** The unticked "Also send me tips on listing images and the occasional
   * offer" box (PHASE_18 P18-06). Only true is consent. */
  marketingConsent: z.boolean().optional(),
  [LEAD_HONEYPOT_FIELD]: z.string().max(500).optional(),
});

export type LeadRequest = z.infer<typeof leadRequestSchema>;

/** True when the honeypot holds anything but whitespace. */
export function isHoneypotTripped(request: LeadRequest): boolean {
  return Boolean(request[LEAD_HONEYPOT_FIELD]?.trim());
}

export const LEAD_INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
