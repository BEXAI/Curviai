"use server";

import { z } from "zod";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import type { BrandPaletteOutcome } from "@/lib/brand/types";
import { checkRateLimit, rateLimitMessage, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import type { SaveResult } from "@/lib/services/types";
import { brandKitInputSchema, brandKitIssueNotice } from "@/lib/validation/brand-kit";

/**
 * Server action behind the brand page. The argument comes straight from the
 * browser, so it is parsed here (Update.md 4.2) and the service then checks
 * the member's role and that any logo key belongs to this workspace.
 */
export async function saveBrandKitAction(kit: unknown): Promise<SaveResult> {
  const parsed = brandKitInputSchema.safeParse(kit);
  if (!parsed.success) {
    return { ok: false, notice: brandKitIssueNotice(parsed.error) };
  }
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, notice: "Sign in to save the brand kit." };
  }
  return services.saveBrandKit(workspace.id, {
    ...parsed.data,
    logoKey: parsed.data.logoKey ?? null,
    hasLogo: Boolean(parsed.data.logoKey),
  });
}

const LogoKey = z.string().min(1).max(512);

/**
 * Suggests brand colors from the uploaded logo (PHASE_16 workstream 7).
 * Rate limited per user and per workspace, since an ambiguous logo costs a
 * vision call. It
 * only returns a suggestion: the kit changes when the seller confirms it in
 * the form and saves through saveBrandKitAction.
 */
export async function suggestBrandPaletteAction(logoKey: unknown): Promise<BrandPaletteOutcome> {
  const parsed = LogoKey.safeParse(logoKey);
  if (!parsed.success) {
    return { ok: false, reason: "foreign_key", notice: brandKitCopy.paletteNeedsLogo };
  }
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, reason: "forbidden", notice: "Sign in to edit the brand kit." };
  }
  // Counted per user and, with the same budget, per workspace: extra seats
  // or a user switching addresses cannot multiply the vision calls one
  // workspace makes, which only the global daily cap would otherwise bound.
  const subject = await userRateLimitSubject(workspace.id);
  const subjects = subject === `ws:${workspace.id}` ? [subject] : [subject, `ws:${workspace.id}`];
  for (const s of subjects) {
    const decision = await checkRateLimit("brand.palette", "user", s);
    if (!decision.allowed) {
      return { ok: false, reason: "rate_limited", notice: rateLimitMessage(decision.retryAfterSeconds) };
    }
  }
  return services.suggestBrandPalette(workspace.id, parsed.data);
}
