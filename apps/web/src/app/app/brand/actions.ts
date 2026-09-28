"use server";

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
